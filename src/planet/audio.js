// Audio: a procedural soundscape that follows the camera (space pad -> entry wind -> clouds -> surf, wind, birds,
// crickets). Everything is synthesised with native WebAudio nodes; no files, no ScriptProcessor. Silent until start()
// is called from a user gesture.
// OWNER: audio agent.
//
// CONTRACT: export function createAudio(app) -> { start(), stop(), toggle(), get on() }
// Drive it from app.onFrame (push a function taking dt) and read app.rig.altitude, app.rig.orbitness(), app.sunDir().
//
// Layers (each has its own mix gain; the per-frame code only moves those gains and a few filter cutoffs):
//   pad      orbit: 4 voices + bass of a warm custom waveform, slowly changing chords (one voice at a time),
//            sparse high "shimmer" notes, all through a long synthetic reverb
//   rush     dive: band-passed pink noise + a narrow whistle band + low roar, pitch/level follow camera speed,
//            only inside the atmosphere; a low-pass "muffle" closes while passing the cloud shell
//   cloud    soft brown-noise whoosh around the cloud shell (CLOUD_R = R + 2600 m)
//   wind     near the surface: gusty pink noise (LFO-driven, no JS per sample), stronger over land / mountains
//   surf     near the sea: scheduled wave envelopes (body low-pass sweep + foam hiss + occasional low thump)
//            plus a steady swell wash; louder at coasts, which are found by sampling terrain around the camera
//   birds    day, land, low: rare short synthesized phrases (sine chirps), very sparing
//   crickets night, land, low: AM-gated sines
// Master: mix -> gentle high-shelf cut -> compressor (soft limiter) -> on/off gain -> destination.

const TAU = Math.PI * 2;
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

const R_PLANET = 60000;
const CLOUD_ALT = 2600;

// chords: bass MIDI note + 4 pad voices (sorted low to high). D major / mixolydian colours, open voicings.
const CHORDS = [
  { b: 38, v: [57, 62, 64, 69] }, // D sus2
  { b: 35, v: [54, 61, 64, 69] }, // Bm11
  { b: 31, v: [55, 62, 66, 71] }, // Gmaj7
  { b: 40, v: [55, 59, 62, 66] }, // Em9 (no root)
  { b: 33, v: [57, 59, 64, 69] }, // A sus2
  { b: 36, v: [55, 60, 64, 67] }, // C (bVII)
];

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fill a buffer from a per-channel generator, crossfading the tail into the head so the loop has no seam.
function loopBuffer(ctx, seconds, channels, gen) {
  const sr = ctx.sampleRate, n = Math.floor(seconds * sr), fade = Math.floor(0.25 * sr);
  const buf = ctx.createBuffer(channels, n, sr);
  for (let c = 0; c < channels; c++) {
    const g = new Float32Array(n + fade);
    gen(g, c);
    let peak = 1e-9;
    for (let i = 0; i < g.length; i++) peak = Math.max(peak, Math.abs(g[i]));
    const k = 0.9 / peak;
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) d[i] = g[i] * k;
    for (let i = 0; i < fade; i++) {
      const w = i / fade, a = Math.sin(w * Math.PI / 2), b = Math.cos(w * Math.PI / 2);
      d[i] = (g[i] * a + g[n + i] * b) * k;
    }
  }
  return buf;
}

function makeNoise(ctx) {
  const rnd = mulberry(0x51ab);
  const white = loopBuffer(ctx, 3, 1, (g) => { for (let i = 0; i < g.length; i++) g[i] = rnd() * 2 - 1; });
  // pink: Paul Kellet's filter bank on white noise
  const pink = loopBuffer(ctx, 7, 2, (g) => {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < g.length; i++) {
      const w = rnd() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520; b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
      g[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
      b6 = w * 0.115926;
    }
  });
  // brown: leaky integrated white
  const brown = loopBuffer(ctx, 5, 2, (g) => {
    let y = 0;
    for (let i = 0; i < g.length; i++) { y = (y + 0.02 * (rnd() * 2 - 1)) * 0.998; g[i] = y; }
  });
  return { white, pink, brown };
}

// A long, dark, stereo reverb tail: decaying noise whose high end dies faster than its low end.
function makeImpulse(ctx, seconds) {
  const sr = ctx.sampleRate, n = Math.floor(seconds * sr), pre = Math.floor(0.025 * sr);
  const buf = ctx.createBuffer(2, n, sr);
  const rnd = mulberry(0x7e11);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / sr;
      const env = Math.exp(-t * 6.9 / seconds) * Math.min(1, t / 0.08);
      const k = 0.55 - 0.45 * Math.min(1, t / seconds); // one-pole low-pass that closes over time
      lp += ((rnd() * 2 - 1) - lp) * k;
      d[i] = lp * env * 0.6;
    }
  }
  return buf;
}

export function createAudio(app) {
  const AC = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;
  let ctx = null, G = null;          // context and graph
  let wantOn = false;
  let unlockArmed = false;
  const rnd = Math.random;
  const lastSet = new Map();

  // per-frame state
  const S = {
    lastPos: null, speed: 0, sea: 0, coast: 0, land: 1, sampleT: 0, mixT: 0,
    nextChord: 0, chord: 0, nextShimmer: 0, nextWave: 0, nextBird: 0, mix: {},
  };

  // ---------- graph ----------
  function pan(value) {
    if (ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = value; return p; }
    const g = ctx.createGain(); g.pan = { value: 0, setTargetAtTime() {}, setValueAtTime() {} }; return g; // old WebKit: mono
  }
  function gain(v = 0) { const g = ctx.createGain(); g.gain.value = v; return g; }
  function filt(type, f, q = 0.707) { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; }
  function osc(type, f) { const o = ctx.createOscillator(); if (typeof type === 'string') o.type = type; else o.setPeriodicWave(type); o.frequency.value = f; return o; }
  function loop(buf, rate = 1) {
    const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.playbackRate.value = rate;
    s.start(0, rnd() * buf.duration * 0.9); return s;
  }
  // a slow LFO added onto an AudioParam (param keeps its own value as the centre)
  function lfo(param, freq, depth, type = 'sine') {
    const o = osc(type, freq), g = gain(depth); o.connect(g); g.connect(param); o.start(); return o;
  }
  const chain = (...n) => { for (let i = 0; i < n.length - 1; i++) n[i].connect(n[i + 1]); return n[n.length - 1]; };

  function build() {
    const t0 = ctx.currentTime;
    const N = makeNoise(ctx);
    const g = {};

    // master: mix -> shelf -> compressor -> out
    g.mix = gain(1);
    g.shelf = filt('highshelf', 6500); g.shelf.gain.value = -4;
    g.comp = ctx.createDynamicsCompressor();
    g.comp.threshold.value = -20; g.comp.knee.value = 12; g.comp.ratio.value = 6;
    g.comp.attack.value = 0.008; g.comp.release.value = 0.35;
    g.out = gain(0);
    chain(g.mix, g.shelf, g.comp, g.out, ctx.destination);

    // reverb
    g.verbIn = gain(1);
    g.verb = ctx.createConvolver();
    g.verb.buffer = makeImpulse(ctx, 4.5);
    g.verbOut = gain(0.55);
    chain(g.verbIn, g.verb, g.verbOut, g.mix);

    // shared noise sources (each read at a different offset/rate so layers stay uncorrelated)
    const pinkA = loop(N.pink, 1), pinkB = loop(N.pink, 0.83), brown = loop(N.brown, 1), white = loop(N.white, 1);
    g.sources = [pinkA, pinkB, brown, white];
    g.oscs = [];

    // ---- pad ----
    const real = new Float32Array(17), imag = new Float32Array(17);
    for (let n = 1; n < 17; n++) imag[n] = Math.pow(n, -1.55) * (n % 2 ? 1 : 0.55);
    const warm = ctx.createPeriodicWave(real, imag);
    g.padFilter = filt('lowpass', 1100, 0.6);
    g.padBreath = gain(1);
    g.pad = gain(0);
    chain(g.padFilter, g.padBreath, g.pad);
    g.pad.connect(g.mix);
    const padSend = gain(0.75); g.pad.connect(padSend); padSend.connect(g.verbIn);
    g.oscs.push(lfo(g.padFilter.frequency, 0.031, 380));
    g.oscs.push(lfo(g.padBreath.gain, 0.047, 0.16));
    const ch = CHORDS[0];
    g.voices = ch.v.map((m, i) => {
      const vg = gain(0), p = pan([-0.55, 0.25, -0.2, 0.55][i]);
      const o1 = osc(warm, mtof(m)), o2 = osc(warm, mtof(m));
      o1.detune.value = -5 - rnd() * 2; o2.detune.value = 5 + rnd() * 2;
      o1.connect(vg); o2.connect(vg); chain(vg, p, g.padFilter);
      o1.start(); o2.start(); g.oscs.push(o1, o2);
      const level = 0.085 - i * 0.008;
      vg.gain.setTargetAtTime(level, t0 + 0.3 + i * 0.7, 2.0);
      return { g: vg, oscs: [o1, o2], level, note: m };
    });
    {
      const vg = gain(0);
      const o1 = osc('sine', mtof(ch.b)), o2 = osc('triangle', mtof(ch.b + 12));
      const o2g = gain(0.25);
      o1.connect(vg); chain(o2, o2g, vg); vg.connect(g.padFilter);
      o1.start(); o2.start(); g.oscs.push(o1, o2);
      vg.gain.setTargetAtTime(0.16, t0 + 0.2, 2.5);
      g.bass = { g: vg, oscs: [o1, o2], mult: [1, 2], level: 0.16, note: ch.b };
    }
    // shimmer bus: mostly wet
    g.shimmer = gain(1);
    const shDry = gain(0.25), shWet = gain(1);
    g.shimmer.connect(shDry); g.shimmer.connect(shWet); shDry.connect(g.pad); shWet.connect(g.verbIn);
    g.shimmerPan = pan(0); g.shimmerPan.connect(g.shimmer);

    // ---- rush (dive wind) ----
    g.muffle = filt('lowpass', 9000, 0.5);
    g.rushBand = filt('bandpass', 500, 0.6);
    g.rush = gain(0);
    chain(pinkA, g.rushBand, g.rush, g.muffle);
    g.whistleBand = filt('bandpass', 900, 7);
    g.whistle = gain(0);
    chain(pinkB, g.whistleBand, g.whistle, g.muffle);
    g.oscs.push(lfo(g.whistleBand.frequency, 0.11, 90));
    g.roarLP = filt('lowpass', 140, 0.7);
    g.roar = gain(0);
    chain(brown, g.roarLP, g.roar, g.muffle);
    g.muffle.connect(g.mix);
    const rushSend = gain(0.12); g.muffle.connect(rushSend); rushSend.connect(g.verbIn);

    // ---- cloud whoosh ----
    g.cloudLP = filt('lowpass', 420, 0.6);
    g.cloud = gain(0);
    chain(brown, g.cloudLP, g.cloud, g.mix);
    g.oscs.push(lfo(g.cloudLP.frequency, 0.17, 140));

    // ---- surface wind (gusty) ----
    g.windBand = filt('bandpass', 520, 0.55);
    g.windHi = filt('bandpass', 2600, 0.9);
    const windHiG = gain(0.22);
    g.gust = gain(0.62);
    g.wind = gain(0);
    pinkB.connect(g.windBand); g.windBand.connect(g.gust);
    chain(pinkB, g.windHi, windHiG, g.gust);
    chain(g.gust, g.wind, g.mix);
    g.oscs.push(lfo(g.gust.gain, 0.071, 0.24), lfo(g.gust.gain, 0.163, 0.13), lfo(g.windBand.frequency, 0.09, 140));

    // ---- surf ----
    g.surf = gain(0);
    g.surf.connect(g.mix);
    const surfSend = gain(0.18); g.surf.connect(surfSend); surfSend.connect(g.verbIn);
    g.surfPan = pan(0);
    g.surfPan.connect(g.surf);
    g.bodyLP = filt('lowpass', 300, 0.4);
    g.bodyEnv = gain(0.12);
    chain(pinkA, g.bodyLP, g.bodyEnv, g.surfPan);
    g.foamBP = filt('bandpass', 4200, 0.5);
    g.foamLP = filt('lowpass', 7500, 0.5);
    g.foamEnv = gain(0.0);
    chain(white, g.foamBP, g.foamLP, g.foamEnv, g.surfPan);
    g.thumpLP = filt('lowpass', 150, 0.7);
    g.thumpEnv = gain(0);
    chain(brown, g.thumpLP, g.thumpEnv, g.surf);
    // steady swell wash (open sea)
    g.swellLP = filt('lowpass', 650, 0.4);
    g.swellAM = gain(0.55);
    g.swell = gain(0);
    chain(pinkB, g.swellLP, g.swellAM, g.swell, g.mix);
    g.oscs.push(lfo(g.swellAM.gain, 0.085, 0.3), lfo(g.swellLP.frequency, 0.085, 220), lfo(g.swellAM.gain, 0.13, 0.12));

    // ---- birds (nodes are created per chirp; this is the bus) ----
    g.birdPan = pan(0);
    g.birdLP = filt('lowpass', 6500, 0.5);
    g.birds = gain(0);
    chain(g.birdPan, g.birdLP, g.birds, g.mix);
    const birdSend = gain(0.9); g.birds.connect(birdSend); birdSend.connect(g.verbIn);

    // ---- crickets ----
    g.crickets = gain(0);
    const crHP = filt('highpass', 2500, 0.7);
    chain(crHP, g.crickets, g.mix);
    const crSend = gain(0.5); g.crickets.connect(crSend); crSend.connect(g.verbIn);
    [[4350, 31, 1.55, -0.6, 1], [4720, 37, 2.1, 0.5, 0.8], [4060, 27, 1.2, 0.1, 0.45]].forEach(([f, pulse, rate, pp, lvl]) => {
      const carrier = osc('sine', f);
      const gp = gain(0.5), gc = gain(0.5), lv = gain(0.03 * lvl), p = pan(pp);
      g.oscs.push(lfo(gp.gain, pulse, 0.5, 'square'), lfo(gc.gain, rate, 0.5, 'square'));
      chain(carrier, gp, gc, lv, p, crHP);
      carrier.start(); g.oscs.push(carrier);
    });

    G = g;
    const now = ctx.currentTime;
    S.nextChord = now + 16 + rnd() * 6;
    S.nextShimmer = now + 4;
    S.nextWave = now + 0.5;
    S.nextBird = now + 3;
  }

  // ---------- scheduled events ----------
  function changeChord(now) {
    let next;
    do { next = Math.floor(rnd() * CHORDS.length); } while (next === S.chord);
    S.chord = next;
    const c = CHORDS[next];
    const order = [0, 1, 2, 3].sort(() => rnd() - 0.5);
    let t = now + 0.3;
    order.forEach((i) => {
      const v = G.voices[i], m = c.v[i];
      if (m === v.note) return;
      v.note = m;
      v.g.gain.setTargetAtTime(0, t, 0.7);
      for (const o of v.oscs) o.frequency.setTargetAtTime(mtof(m), t + 2.6, 0.04);
      v.g.gain.setTargetAtTime(v.level, t + 2.8, 1.7);
      t += 1.5 + rnd() * 1.5;
    });
    if (c.b !== G.bass.note) {
      const b = G.bass; b.note = c.b;
      b.g.gain.setTargetAtTime(0, now + 0.8, 1.0);
      b.oscs.forEach((o, k) => o.frequency.setTargetAtTime(mtof(c.b) * b.mult[k], now + 4.3, 0.05));
      b.g.gain.setTargetAtTime(b.level, now + 4.5, 2.2);
    }
  }

  function shimmer(now) {
    const c = CHORDS[S.chord];
    const m = c.v[Math.floor(rnd() * 4)] + (rnd() < 0.6 ? 12 : 24);
    const f = mtof(Math.min(m, 93));
    const t = now + 0.05, amp = 0.022 + rnd() * 0.018;
    G.shimmerPan.pan.setTargetAtTime((rnd() - 0.5) * 1.4, t, 0.05);
    for (const [mult, a] of [[1, 1], [2.001, 0.18]]) {
      const o = osc('sine', f * mult), e = gain(0);
      e.gain.setTargetAtTime(amp * a, t, 0.9);
      e.gain.setTargetAtTime(0, t + 2.6, 2.2);
      o.connect(e); e.connect(G.shimmerPan);
      o.start(t); o.stop(t + 14);
      o.onended = () => { o.disconnect(); e.disconnect(); };
    }
  }

  function wave(T) {
    const size = 0.45 + rnd() * 0.55, big = rnd() < 0.2;
    const rise = 1.5 + rnd() * 1.5, peak = T + rise;
    G.surfPan.pan.setTargetAtTime((rnd() - 0.5) * 1.1, T, 1.2);
    // body: low rumble that opens up as the wave builds, then breaks and recedes
    G.bodyLP.frequency.setTargetAtTime(380 + 1300 * size, T, rise * 0.45);
    G.bodyLP.frequency.setTargetAtTime(280, peak + 0.2, 1.6);
    G.bodyEnv.gain.setTargetAtTime(0.25 + 0.55 * size, T, rise * 0.4);
    G.bodyEnv.gain.setTargetAtTime(0.1, peak + 0.15, 1.3 + size);
    // foam: the hiss of the break and the wash running back
    G.foamEnv.gain.setTargetAtTime(0.32 * size, peak - 0.15, 0.09);
    G.foamEnv.gain.setTargetAtTime(0.06 * size, peak + 0.35, 0.6);
    G.foamEnv.gain.setTargetAtTime(0.0, peak + 1.8, 1.4);
    G.foamBP.frequency.setTargetAtTime(5200, peak - 0.15, 0.1);
    G.foamBP.frequency.setTargetAtTime(2600, peak + 0.4, 1.5);
    if (big) {
      G.thumpEnv.gain.setTargetAtTime(0.8 * size, peak, 0.025);
      G.thumpEnv.gain.setTargetAtTime(0, peak + 0.12, 0.45);
    }
    return T + rise + 3.5 + rnd() * 4.5; // next wave
  }

  function chirp(t, f0, f1, dur, amp) {
    const o = osc('sine', f0), e = gain(0);
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    e.gain.setValueAtTime(0, t);
    e.gain.linearRampToValueAtTime(amp, t + dur * 0.25);
    e.gain.setTargetAtTime(0, t + dur * 0.55, dur * 0.2);
    o.connect(e); e.connect(G.birdPan);
    o.start(t); o.stop(t + dur + 0.25);
    o.onended = () => { o.disconnect(); e.disconnect(); };
  }

  function birdPhrase(now) {
    let t = now + 0.05;
    G.birdPan.pan.setValueAtTime((rnd() - 0.5) * 1.5, t);
    G.birdLP.frequency.setValueAtTime(3800 + rnd() * 3500, t); // distance
    const kind = rnd();
    if (kind < 0.5) {            // twitter
      const n = 3 + Math.floor(rnd() * 5), base = 3000 + rnd() * 1300, up = rnd() < 0.5;
      for (let i = 0; i < n; i++) {
        const f0 = base * (1 + (rnd() - 0.5) * 0.12), d = 0.045 + rnd() * 0.035;
        chirp(t, f0, f0 * (up ? 1.3 : 0.72), d, 0.11);
        t += d + 0.06 + rnd() * 0.07;
      }
    } else if (kind < 0.8) {     // two or three soft whistles
      const n = 2 + Math.floor(rnd() * 2), base = 1900 + rnd() * 700;
      for (let i = 0; i < n; i++) {
        const d = 0.2 + rnd() * 0.15, f0 = base * (i === n - 1 ? 0.85 : 1);
        chirp(t, f0 * 1.06, f0 * 0.94, d, 0.08);
        t += d + 0.12 + rnd() * 0.1;
      }
    } else {                     // short trill
      const n = 7 + Math.floor(rnd() * 6), base = 3400 + rnd() * 600;
      for (let i = 0; i < n; i++) {
        const f0 = base * (1 - i * 0.012);
        chirp(t, f0, f0 * 0.8, 0.03, 0.07);
        t += 0.05;
      }
    }
  }

  // ---------- per frame ----------
  function sampleSurroundings(rig) {
    // fraction of sea around the camera (rings at 250 m and 900 m) -> surf / land weights
    const g = rig.groundDir || rig.pos.map((v) => v / Math.hypot(...rig.pos));
    const hAt = rig.heightAt;
    if (!hAt) { S.sea = rig.groundH < 0 ? 1 : 0; S.coast = 0; return; }
    let east = [g[2], 0, -g[0]];
    const el = Math.hypot(east[0], east[2]) || 1;
    east = [east[0] / el, 0, east[2] / el];
    const north = [g[1] * east[2], g[2] * east[0] - g[0] * east[2], -g[1] * east[0]];
    let sea = 0, wsum = 0;
    const under = rig.groundH < 0 ? 1 : 0;
    sea += under * 2; wsum += 2;
    for (const [dist, w] of [[250, 1.2], [900, 0.8]]) {
      const a = dist / R_PLANET;
      for (let k = 0; k < 6; k++) {
        const th = k / 6 * TAU + dist;
        const c = Math.cos(th) * a, s = Math.sin(th) * a;
        const d = [g[0] + east[0] * c + north[0] * s, g[1] + east[1] * c + north[1] * s, g[2] + east[2] * c + north[2] * s];
        const l = Math.hypot(d[0], d[1], d[2]);
        sea += (hAt(d[0] / l, d[1] / l, d[2] / l) < 0 ? 1 : 0) * w; wsum += w;
      }
    }
    const f = sea / wsum;
    S.sea = f;
    // coast: both land and sea close by (or a low beach under the camera)
    S.coast = clamp(Math.min(f, 1 - f) * 3.2 + (rig.groundH >= 0 && rig.groundH < 12 && f > 0.05 ? 0.4 : 0));
  }

  function frame(dt) {
    if (!ctx || !G || !wantOn || ctx.state !== 'running') return;
    const rig = app.rig, now = ctx.currentTime;
    // camera speed (m/s), ignoring teleports
    const p = rig.pos;
    if (S.lastPos && dt > 0) {
      const d = Math.hypot(p[0] - S.lastPos[0], p[1] - S.lastPos[1], p[2] - S.lastPos[2]);
      const v = d > 60000 ? 0 : d / dt;
      S.speed += (v - S.speed) * (1 - Math.exp(-dt * 3));
    }
    S.lastPos = p.slice();

    S.sampleT -= dt;
    if (S.sampleT <= 0) {
      S.sampleT = 0.4;
      if (rig.altitude < 5000) sampleSurroundings(rig); else { S.sea = rig.groundH < 0 ? 1 : 0; S.coast = 0; }
    }

    // events
    if (now > S.nextChord) { changeChord(now); S.nextChord = now + 20 + rnd() * 10; }
    if (now > S.nextWave + 2) S.nextWave = now + 0.2; // after a stall/suspend
    if (now > S.nextWave - 0.3) S.nextWave = wave(Math.max(now, S.nextWave));
    const M = S.mix;
    if (now > S.nextShimmer) {
      if ((M.pad || 0) > 0.05) shimmer(now);
      S.nextShimmer = now + 5 + rnd() * 9;
    }
    if (now > S.nextBird) {
      if ((M.birds || 0) > 0.05 && rnd() < M.birds) {
        birdPhrase(now);
        if (rnd() < 0.3) S.nextBird = now + 1.5 + rnd() * 2; // an answer
        else S.nextBird = now + 7 + rnd() * 16;
      } else S.nextBird = now + 3 + rnd() * 5;
    }

    // mix (~20 Hz)
    S.mixT -= dt;
    if (S.mixT > 0) return;
    S.mixT = 0.05;
    const alt = rig.altitude;
    const gh = rig.groundH || 0;
    const agl = Math.max(0, alt - Math.max(gh, 0));
    const o = rig.orbitness();
    const sd = app.sunDir();
    const pl = Math.hypot(...p) || 1;
    const sunUp = (p[0] * sd[0] + p[1] * sd[1] + p[2] * sd[2]) / pl;
    const night = 1 - smooth(-0.14, 0.08, sunUp);
    const sp = clamp(Math.log10(1 + S.speed / 25) / 2.6);
    const atmo = 1 - smooth(12000, 24000, alt);
    const cloud = Math.exp(-Math.pow((alt - CLOUD_ALT) / 750, 2));
    const near = 1 - smooth(40, 1800, agl);
    const nearSea = Math.pow(1 - smooth(10, 2200, agl), 1.5);
    const sea = S.sea, land = 1 - sea, coast = S.coast;
    const mountain = smooth(300, 1100, gh);

    M.pad = smooth(0.18, 0.75, o) * (1 - 0.25 * night);
    M.rush = atmo * Math.pow(sp, 1.4) * (1 - 0.5 * near);
    M.roar = atmo * smooth(0.55, 1, sp) * (1 - near);
    M.cloud = cloud * atmo * (0.2 + 0.8 * sp);
    M.wind = atmo * (1 - smooth(0.3, 0.8, o)) * (0.28 + 0.45 * near * land + 0.35 * mountain) * (1 - 0.4 * night);
    M.surf = nearSea * clamp(coast * 1.0 + sea * 0.45) * (1 - 0.2 * night);
    M.swell = nearSea * sea * (1 - 0.2 * night);
    M.birds = near * land * (1 - night) * (1 - 0.6 * mountain) * (1 - 0.5 * coast);
    M.crickets = near * land * night * (1 - mountain);
    M.sp = sp; M.night = night; M.sea = sea; M.coast = coast;

    // only touch a param when its target really moves (keeps the automation timelines short)
    const set = (param, v, k = 0.25) => {
      const last = lastSet.get(param);
      if (last !== undefined && Math.abs(v - last) <= 0.003 * Math.max(0.05, Math.abs(last))) return;
      lastSet.set(param, v);
      param.setTargetAtTime(v, now, k);
    };
    set(G.pad.gain, M.pad * 0.2, 0.6);
    set(G.padFilter.frequency, 700 + 650 * (1 - night) + 300 * (1 - o), 1.5);
    set(G.rush.gain, M.rush * 0.4);
    set(G.whistle.gain, M.rush * 0.16);
    set(G.roar.gain, M.roar * 0.5);
    set(G.rushBand.frequency, 300 + 1500 * sp, 0.3);
    set(G.whistleBand.frequency, 650 + 1700 * sp, 0.4);
    set(G.muffle.frequency, 9000 - 8300 * cloud, 0.2);
    set(G.cloud.gain, M.cloud * 0.4, 0.35);
    set(G.wind.gain, M.wind * 0.5, 0.5);
    set(G.windBand.frequency, 420 + 260 * mountain + 300 * sp, 0.8);
    set(G.surf.gain, M.surf * 0.42, 0.5);
    set(G.swell.gain, M.swell * 0.26, 0.6);
    set(G.birds.gain, M.birds * 0.6, 0.6);
    set(G.crickets.gain, M.crickets * 0.8, 1.0);
  }

  // ---------- lifecycle (iOS-safe) ----------
  function armUnlock() {
    if (unlockArmed) return;
    unlockArmed = true;
    const evs = ['pointerdown', 'touchend', 'keydown', 'click'];
    const fn = () => {
      evs.forEach((e) => removeEventListener(e, fn, true));
      unlockArmed = false;
      if (wantOn && ctx && ctx.state !== 'running' && !document.hidden) ctx.resume().catch(() => {});
    };
    evs.forEach((e) => addEventListener(e, fn, true));
  }

  function resume() {
    if (!ctx || ctx.state === 'closed') return;
    if (ctx.state !== 'running') {
      const p = ctx.resume();
      if (p && p.then) p.then(() => { if (ctx.state !== 'running') armUnlock(); }, () => armUnlock());
    }
  }

  function fadeIn() {
    const now = ctx.currentTime;
    G.out.gain.cancelScheduledValues(now);
    G.out.gain.setValueAtTime(G.out.gain.value, now);
    G.out.gain.setTargetAtTime(0.85, now + 0.05, 0.9);
  }

  let listening = false;
  function listen() {
    if (listening) return;
    listening = true;
    document.addEventListener('visibilitychange', () => {
      if (!ctx) return;
      if (document.hidden) { if (ctx.state === 'running') ctx.suspend().catch(() => {}); } else if (wantOn) resume();
    });
    addEventListener('pageshow', () => { if (wantOn && !document.hidden) resume(); });
    ctx.onstatechange = () => {
      // iOS 'interrupted' (call, Siri, other app) or an unexpected suspend: try again, else on the next touch
      if (wantOn && !document.hidden && ctx.state !== 'running' && ctx.state !== 'closed') {
        setTimeout(resume, 400);
        armUnlock();
      }
    };
    app.onFrame.push(frame);
  }

  function start() {
    if (!AC) return;
    wantOn = true;
    if (!ctx) {
      try { ctx = new AC({ latencyHint: 'playback' }); } catch (e) { ctx = new AC(); }
      // iOS 17+: play even with the ring/silent switch on, since the user asked for sound
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* ignore */ }
      // old iOS unlock: a one-sample silent buffer started inside the gesture
      try {
        const b = ctx.createBufferSource(); b.buffer = ctx.createBuffer(1, 1, 22050); b.connect(ctx.destination); b.start(0);
      } catch (e) { /* ignore */ }
      resume();
      build();
      listen();
      S.lastPos = null;
    } else resume();
    fadeIn();
  }

  function stop() {
    wantOn = false;
    if (!ctx || !G) return;
    const now = ctx.currentTime;
    G.out.gain.cancelScheduledValues(now);
    G.out.gain.setValueAtTime(G.out.gain.value, now);
    G.out.gain.setTargetAtTime(0, now, 0.15);
    setTimeout(() => { if (!wantOn && ctx.state === 'running') ctx.suspend().catch(() => {}); }, 800);
  }

  return {
    start, stop,
    toggle() { if (wantOn) stop(); else start(); return wantOn; },
    get on() { return wantOn; },
    // debugging / tests: current layer weights (0..1) and the context
    get mix() { return { ...S.mix, speed: S.speed }; },
    get context() { return ctx; },
    get output() { return G && G.out; },
  };
}
