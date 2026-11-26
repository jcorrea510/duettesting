// Planet: WebGL2 setup, shader assembly, frame loop, adaptive resolution and the post passes.
// OWNER: main session (performance agent).
//
// Frame pipeline (every frame):
//   1. main shader (COMMON..COMPOSITE) -> scene texture, RGBA8, at the adaptive render resolution (state.scale)
//   2. while the camera is still: RESOLVE pass blends a jittered frame into a history texture (anti-aliasing
//      that refines over a few frames; reset the moment the camera moves, so there is no ghosting)
//   3. UPSCALE pass -> canvas at full device resolution (Catmull-Rom + clamped sharpening)
// The governor (adapt) picks render scale, uQuality and the frame-rate target from measured frame times.
// Debug: add "debug" to the hash (#debug) for a tiny fps/scale/quality overlay; numbers are always in app.perf.
import { COMMON } from './glsl/common.js';
import { ATMOSPHERE, TRANS_LUT_FS, TRANS_LUT_W, TRANS_LUT_H } from './glsl/atmosphere.js';
import { CLOUDS } from './glsl/clouds.js';
import { TERRAIN } from './glsl/terrain.js';
import { OCEAN } from './glsl/ocean.js';
import { EXTRAS } from './glsl/extras.js';
import { COMPOSITE, POST_VS, RESOLVE_FS, UPSCALE_FS } from './glsl/composite.js';
import { terrainHeight, setSeed, PLANET_R } from './terrain-cpu.js';
import { CameraRig } from './camera.js';
import { initUI } from './ui.js';
import { createAudio } from './audio.js';

const canvas = document.getElementById('c');
const VS = POST_VS;

// ---------- URL parameters ----------
function parseHash() {
  const out = {};
  for (const kv of location.hash.replace(/^#/, '').split('&')) {
    if (!kv) continue;
    const i = kv.indexOf('=');
    const k = decodeURIComponent(i < 0 ? kv : kv.slice(0, i));
    out[k] = i < 0 ? '1' : decodeURIComponent(kv.slice(i + 1));
  }
  return out;
}
const params = parseHash();
const num = (v, d) => { const x = parseFloat(v); return isFinite(x) ? x : d; };
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

const state = {
  seed: Math.max(1, Math.floor(num(params.seed, 1))) >>> 0,
  sunAngle: num(params.sun, 0.9),        // radians around the polar axis
  sunTilt: 0.22,
  sunSpeed: params.still ? 0 : 0.0035,   // rad/s: the day goes by slowly
  still: !!params.still,
  scale: clamp(num(params.scale, 0.6), 0.2, 1),   // render scale relative to the canvas (device pixels, dpr <= 2)
  quality: params.q !== undefined ? clamp(num(params.q, 1) | 0, 0, 2) : 1,
  fps: 0,
  exposure: 0.14,        // base exposure (day); the applied value is state.exposureNow
  exposureNow: 0.14,
  time: num(params.time, 0),
  fovNear: 55, fovFar: 48,
};
setSeed(state.seed);
const fixedScale = params.scale !== undefined || state.still;
const fixedQuality = params.q !== undefined;

// ---------- GL ----------
const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
if (!gl) {
  document.body.classList.add('nogl');
  throw new Error('WebGL2 unavailable');
}

// line -> chunk map so a shader error says which module it is in
const CHUNKS = [['common.js', COMMON], ['atmosphere.js', ATMOSPHERE], ['clouds.js', CLOUDS], ['terrain.js', TERRAIN],
  ['ocean.js', OCEAN], ['extras.js', EXTRAS], ['composite.js', COMPOSITE]];
const mainSrc = CHUNKS.map((c) => c[1]).join('');
function chunkOf(src, line) {
  if (src !== mainSrc) return '';
  let start = 1;
  for (const [name, s] of CHUNKS) {
    const n = s.split('\n').length - 1;
    if (line < start + n + 1) return ` [${name}, line ${line - start + 1} of its GLSL string]`;
    start += n;
  }
  return '';
}
function annotate(log, src) {
  const lines = src.split('\n'), out = [], seen = new Set();
  for (const ln of log.split('\n')) {
    if (!ln.trim()) continue;
    const m = /(?:ERROR|WARNING):\s*\d+:(\d+)/.exec(ln);
    out.push(ln + (m ? chunkOf(src, +m[1]) : ''));
    if (m && !seen.has(m[1]) && seen.size < 6) {
      seen.add(m[1]);
      const n = +m[1];
      for (let k = Math.max(1, n - 2); k <= Math.min(lines.length, n + 1); k++) out.push(`   ${k === n ? '>' : ' '}${String(k).padStart(5)} | ${lines[k - 1]}`);
    }
  }
  return out.join('\n');
}

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  return s;
}
function link(name, fsSrc) {
  const p = gl.createProgram();
  const v = compile(gl.VERTEX_SHADER, VS), f = compile(gl.FRAGMENT_SHADER, fsSrc);
  gl.attachShader(p, v); gl.attachShader(p, f);
  gl.linkProgram(p);
  return { name, p, v, f, src: fsSrc };
}
function ready(prog, parallel) {
  return !parallel || gl.getProgramParameter(prog.p, parallel.COMPLETION_STATUS_KHR);
}
// returns null on success (and fills prog.u), or a readable report
function check(prog) {
  if (!gl.getProgramParameter(prog.p, gl.LINK_STATUS)) {
    const parts = [];
    for (const [kind, sh, src] of [['vertex', prog.v, VS], ['fragment', prog.f, prog.src]]) {
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) parts.push(`${kind} shader of "${prog.name}" failed to compile:\n` + annotate(gl.getShaderInfoLog(sh) || '(no log)', src));
    }
    if (!parts.length) parts.push(`program "${prog.name}" failed to link:\n` + (gl.getProgramInfoLog(prog.p) || '(no log)'));
    return parts.join('\n');
  }
  const u = {};
  const n = gl.getProgramParameter(prog.p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const a = gl.getActiveUniform(prog.p, i); u[a.name] = gl.getUniformLocation(prog.p, a.name); }
  prog.u = u;
  gl.detachShader(prog.p, prog.v); gl.detachShader(prog.p, prog.f);
  gl.deleteShader(prog.v); gl.deleteShader(prog.f);
  return null;
}

function makeTarget(w, h, internal, type) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, gl.RGBA, type, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { tex, fbo, w, h, ok };
}
function freeTarget(t) { if (t) { gl.deleteFramebuffer(t.fbo); gl.deleteTexture(t.tex); } }

// All GL objects live in G so they can be rebuilt after a context loss.
let G = null;
function createGL() {
  const t0 = performance.now();
  const ext = {
    parallel: gl.getExtension('KHR_parallel_shader_compile'),
    timer: params.notimer ? null : gl.getExtension('EXT_disjoint_timer_query_webgl2'),
    cbf: gl.getExtension('EXT_color_buffer_float'),
  };
  const g = { ext, t0, compiled: false, failed: false, lost: false, lutDone: false, rt: null, histFmt: null, queries: [], freeQ: [] };
  // the big program first so the driver starts on it as early as possible
  g.mainProg = link('planet', mainSrc);
  g.lutProg = link('transmittance LUT', COMMON + ATMOSPHERE + TRANS_LUT_FS);
  g.resolveProg = link('resolve', RESOLVE_FS);
  g.upProg = link('upscale', UPSCALE_FS);
  g.progs = [g.mainProg, g.lutProg, g.resolveProg, g.upProg];
  g.vao = gl.createVertexArray();
  g.lut = makeTarget(TRANS_LUT_W, TRANS_LUT_H, gl.RGBA8, gl.UNSIGNED_BYTE);
  return g;
}

// polls the parallel compile; true once everything is linked and checked
function pollCompile() {
  if (!G.progs.every((p) => ready(p, G.ext.parallel))) return false;
  for (const p of G.progs) {
    const err = check(p);
    if (err) {
      G.failed = true;
      app.error = err;
      document.body.classList.add('glerror');
      console.error('[planet] shader build failed. Nothing will render until this is fixed.\n' + err);
      showDebugError(err);
      return false;
    }
  }
  G.compiled = true;
  perf.compileMs = Math.round(performance.now() - G.t0);
  return true;
}

// render targets at render resolution: scene (RGBA8) + two history buffers (RGBA16F when renderable, else RGBA8)
function ensureTargets(rw, rh) {
  const rt = G.rt;
  if (rt && rt.w === rw && rt.h === rh) return rt;
  if (rt) { freeTarget(rt.scene); freeTarget(rt.h0); freeTarget(rt.h1); }
  const scene = makeTarget(rw, rh, gl.RGBA8, gl.UNSIGNED_BYTE);
  let h0 = null, h1 = null;
  if (G.histFmt !== 'rgba8' && G.ext.cbf && !params.hist8) {
    h0 = makeTarget(rw, rh, gl.RGBA16F, gl.HALF_FLOAT);
    h1 = makeTarget(rw, rh, gl.RGBA16F, gl.HALF_FLOAT);
    if (h0.ok && h1.ok) G.histFmt = 'rgba16f';
    else { freeTarget(h0); freeTarget(h1); h0 = h1 = null; }
  }
  if (!h0) {
    G.histFmt = 'rgba8';
    h0 = makeTarget(rw, rh, gl.RGBA8, gl.UNSIGNED_BYTE);
    h1 = makeTarget(rw, rh, gl.RGBA8, gl.UNSIGNED_BYTE);
  }
  G.rt = { w: rw, h: rh, scene, h0, h1, accum: 0 };
  return G.rt;
}

// ---------- GPU timer (optional; Chrome desktop mostly) ----------
function timerBegin() {
  const T = G.ext.timer;
  if (!T || G.queries.length > 4) return null;
  const q = G.freeQ.pop() || gl.createQuery();
  if (!q) return null;
  gl.beginQuery(T.TIME_ELAPSED_EXT, q);
  return q;
}
function timerEnd(q) {
  if (!q) return;
  gl.endQuery(G.ext.timer.TIME_ELAPSED_EXT);
  G.queries.push(q);
}
function timerPoll() {
  const T = G.ext.timer;
  if (!T) return;
  while (G.queries.length) {
    const q = G.queries[0];
    if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
    const disjoint = gl.getParameter(T.GPU_DISJOINT_EXT);
    const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
    G.queries.shift(); G.freeQ.push(q);
    if (!disjoint && ns > 0) gov.gpuSample(ns / 1e6);
  }
}

// ---------- camera, sun ----------
function sunDir() {
  const a = state.sunAngle, t = state.sunTilt;
  return [Math.cos(a) * Math.cos(t), Math.sin(t), Math.sin(a) * Math.cos(t)];
}
const rig = new CameraRig({ canvas, heightAt: (x, y, z) => terrainHeight(x, y, z, 9), R: PLANET_R, sunDir });
if (params.cam) rig.setFromHash(params.cam);

// ---------- output size ----------
const perf = {
  fps: 0, frameMs: 0, gpuMs: 0, refreshHz: 60, targetFps: 60, scale: state.scale, quality: state.quality,
  rw: 0, rh: 0, ow: 0, oh: 0, mode: '', accum: 0, exposure: state.exposure, compileMs: 0, histFmt: '', timer: false,
  drops: 0, raises: 0,
};
function outputSize() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  return [Math.max(1, Math.round(canvas.clientWidth * dpr)), Math.max(1, Math.round(canvas.clientHeight * dpr)), dpr];
}
function resizeCanvas() {
  const [w, h] = outputSize();
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}

// ---------- governor: render scale, quality tier, frame-rate target ----------
// Cost is ~ proportional to rendered pixels (scale^2).
// - Drops are quick: 4 missed frames in a row (a heavy view appeared, e.g. entering the clouds) or a bad second.
// - Raises are gradual. With a GPU timer the next scale is computed from the measured GPU time (aiming at 80% of
//   the frame); without one (Safari) it probes upward in small steps. If a probe fails right after a raise, it goes
//   straight back to the last good scale and that scale becomes a ceiling, held for 10 s, 20 s, then 40 s (or until
//   the camera altitude changes a lot) before it is tried again, so it cannot oscillate.
// - Quality: 1 normally; 0 once the render density would fall below Q1_DENSITY render px per CSS px; back to 1 when
//   there is clear room; 2 only when a GPU timer proves lots of headroom at the maximum scale.
// - On >= 100 Hz displays frames are paced to 60 fps (72 at 144 Hz) unless the full-resolution frame is shown to fit
//   the native refresh rate (a trial that is undone at the first sign of trouble).
const Q1_DENSITY = 0.6, MIN_DENSITY = 0.4, MAX_RENDER_PX = 3.2e6, START_RENDER_PX = 1.2e6;
const gov = {
  vsync: 1 / 60, vsyncSticky: 1, rafIv: [], lastRaf: 0,
  k: 1,                  // render every k-th vsync
  allowNative: false,    // high-refresh display running at its native rate (proven headroom)
  nativeTrial: 0, nativeBanUntil: 0, nativeBan: 30,
  win: [], gpu: [], acc: 0, cool: 8, stable: 0,
  ceil: 1, holdUntil: 0, fails: 0, lastFail: -1e9, failAlt: 1,
  lastGood: 0, lastRaiseAt: -1e9, alt: 1, ceilSeen: 9,
  qBanUntil: 0, qBan: 20,
  bounds() {
    const [ow, oh, dpr] = outputSize();
    const sMax = Math.min(1, Math.sqrt(MAX_RENDER_PX / (ow * oh)));
    return { sMax, sMin: Math.min(sMax, Math.max(0.15, MIN_DENSITY / dpr)), sQ1: Math.min(sMax, Q1_DENSITY / dpr), ow, oh, dpr };
  },
  init() {
    if (fixedScale) return;
    const b = this.bounds();
    state.scale = clamp(Math.round(Math.sqrt(START_RENDER_PX / (b.ow * b.oh)) * 100) / 100, b.sQ1, Math.min(0.85, b.sMax));
    this.ceil = b.sMax;
  },
  // every rAF callback, rendered or not: estimate the display refresh
  raf(now) {
    if (this.lastRaf) {
      const iv = (now - this.lastRaf) / 1000;
      if (iv > 1 / 260 && iv < 0.1) this.rafIv.push(iv);
      if (this.rafIv.length >= 30) {
        const s = this.rafIv.slice().sort((a, b) => a - b);
        const p10 = s[Math.floor(s.length * 0.1)];
        this.rafIv.length = 0;
        // sticky minimum: a GPU-bound phase must not make us believe the display is slower than it is
        this.vsyncSticky = Math.min(this.vsyncSticky, p10);
        let v = this.vsyncSticky;
        if (Math.abs(1 / v - 60) < 4) v = 1 / 60;
        this.vsync = v;
        perf.refreshHz = Math.round(1 / v);
        this.updatePacing();
      }
    }
    this.lastRaf = now;
  },
  updatePacing() {
    const hz = 1 / this.vsync;
    this.k = hz >= 100 && !this.allowNative ? Math.max(1, Math.floor(hz / 60 + 0.01)) : 1;
    perf.targetFps = Math.round(hz / this.k);
  },
  target() { return this.vsync * this.k; },
  // should this rAF render? (pacing on high-refresh displays)
  due(now, last) { return this.k <= 1 || (now - last) / 1000 >= this.target() - this.vsync * 0.5; },
  gpuSample(ms) { this.gpu.push(ms); if (this.gpu.length > 30) this.gpu.shift(); perf.gpuMs = ms; perf.timer = true; },
  reset(cool = 3) { this.win.length = 0; this.gpu.length = 0; this.acc = 0; this.cool = cool; },
  setScale(s) {
    s = Math.round(s * 100) / 100;
    if (s !== state.scale) { state.scale = s; this.reset(3); }
  },
  drop(factor, now) {
    const b = this.bounds();
    this.stable = 0;
    if (this.allowNative) {           // first give up the native high refresh rate
      this.allowNative = false; this.nativeTrial = 0;
      this.nativeBanUntil = now + this.nativeBan; this.nativeBan = Math.min(600, this.nativeBan * 2);
      this.updatePacing(); this.reset(6); perf.drops++;
      return;
    }
    if (state.quality === 2 && !fixedQuality) { state.quality = 1; this.qBanUntil = now + 60; this.reset(4); perf.drops++; return; }
    const q0 = state.quality;
    let s;
    if (now - this.lastRaiseAt < 3 && this.lastGood && this.lastGood < state.scale) {
      // a probe failed: back to the last good scale, and hold below this one for a while (longer each time)
      this.fails = now - this.lastFail < 90 ? this.fails + 1 : 1;
      this.lastFail = now;
      this.ceil = Math.min(this.ceil, state.scale);
      this.ceilSeen = state.scale;
      this.failAlt = this.alt;
      this.holdUntil = now + Math.min(40, 10 * 2 ** (this.fails - 1));
      s = this.lastGood;
    } else {
      s = state.scale * factor;      // the view got heavier
    }
    this.lastRaiseAt = -1e9;
    if (state.quality === 1 && !fixedQuality && s < b.sQ1) {
      if (state.scale > b.sQ1 + 0.01) s = b.sQ1;
      else {
        // already at the q1 floor: switch to the fast tier, which buys back some resolution
        state.quality = 0;
        this.qBanUntil = now + this.qBan; this.qBan = Math.min(300, this.qBan * 2);
        s = Math.min(b.sMax, state.scale * 1.1);
      }
    }
    s = Math.round(Math.max(b.sMin, s) * 100) / 100;
    if (s === state.scale && q0 === state.quality) { this.win.length = 0; return; }   // at the floor: nothing left to give
    perf.drops++;
    this.setScale(s);
    if (q0 !== state.quality) this.reset(4);
  },
  // once per rendered frame: iv = seconds since the previous rendered frame, now in seconds
  frame(iv, now, alt) {
    if (fixedScale) return;
    this.alt = Math.max(1, alt);
    if (iv > 5) { this.reset(4); return; }          // a long stall (hidden tabs are handled by visibilitychange)
    if (this.cool > 0) { this.cool--; return; }
    const T = this.target();
    const miss = (x) => x > T * 1.3;
    this.win.push(iv); if (this.win.length > 90) this.win.shift();
    const n = this.win.length;
    // fast path: 4 missed frames in a row. Intervals are quantised to vsync, so one missed vsync (~2T) may be a
    // small overrun: drop moderately; bigger overruns are sized from the measured time.
    if (n >= 4 && miss(this.win[n - 1]) && miss(this.win[n - 2]) && miss(this.win[n - 3]) && miss(this.win[n - 4])) {
      const m = this.win.slice(-4).sort((a, c) => a - c);
      const med = (m[1] + m[2]) / 2;
      this.drop(med < T * 2.1 ? 0.85 : clamp(Math.sqrt(T / med) * 0.95, 0.65, 0.85), now);
      return;
    }
    // slow path: once per second
    this.acc += iv;
    if (this.acc < 1) return;
    this.acc = 0;
    const s = this.win.slice().sort((a, c) => a - c);
    const p50 = s[s.length >> 1];
    const missRate = this.win.filter(miss).length / n;
    this.win.length = 0;
    if (this.nativeTrial) {
      // trial of the native refresh rate at full resolution: keep it only if nearly every frame made it
      if (missRate < 0.05) { this.nativeTrial = 0; this.nativeBan = 30; }
      else this.drop(1, now);
      return;
    }
    if (missRate > 0.12 || p50 > T * 1.15) { this.drop(p50 < T * 2.1 ? 0.9 : clamp(Math.sqrt(T / p50) * 0.97, 0.75, 0.9), now); return; }
    if (missRate > 0.04) { this.drop(0.96, now); return; }   // a few misses: back off a little
    this.stable++;
    const b = this.bounds();
    // the ceiling belongs to the view it was found in: it lapses after its hold time, or once the camera has
    // changed altitude a lot (a different view, maybe much cheaper)
    if (now > this.holdUntil || Math.abs(Math.log(this.alt / this.failAlt)) > 0.7) { this.ceil = b.sMax; this.holdUntil = 0; }
    const gpu = this.gpu.length >= 5 ? this.gpu.slice().sort((a, c) => a - c)[Math.floor(this.gpu.length * 0.75)] / 1000 : 0;
    // q0 -> q1 once there is clear room again
    if (state.quality === 0 && !fixedQuality && now > this.qBanUntil && this.stable >= 3 && state.scale >= Math.min(b.sMax, b.sQ1 * 1.3) - 0.005) {
      state.quality = 1; this.stable = 0;
      this.lastGood = 0; this.lastRaiseAt = -1e9;
      this.setScale(Math.max(b.sQ1, state.scale * 0.85));
      return;
    }
    const cap = Math.min(b.sMax, this.ceil < b.sMax ? this.ceil * 0.97 : b.sMax);
    let next = state.scale;
    if (gpu > 0) next = state.scale * clamp(Math.sqrt(T * 0.8 / gpu), 1, 1.15);
    else if (this.stable >= 2) next = state.scale * (state.scale * 1.08 < Math.min(cap, this.lastFail > now - 90 ? this.ceilSeen : 9) * 0.92 ? 1.08 : 1.04);
    next = Math.min(next, cap);
    if (next > state.scale + 0.005) {
      perf.raises++;
      this.lastGood = state.scale; this.lastRaiseAt = now;
      this.setScale(next);
      return;
    }
    if (state.scale < b.sMax - 0.005 || this.stable < 5) return;
    // at full resolution with headroom: photo quality (only when measured), then the native refresh rate
    if (!fixedQuality && state.quality === 1 && gpu > 0 && gpu < T * 0.35 && now > this.qBanUntil) { state.quality = 2; this.stable = 0; this.reset(4); return; }
    const hz = 1 / this.vsync;
    if (hz >= 100 && !this.allowNative && now > this.nativeBanUntil && (gpu === 0 || gpu < this.vsync * 0.8)) {
      this.allowNative = true; this.nativeTrial = 1; this.stable = 0;
      this.updatePacing(); this.reset(6);
    }
  },
};

// ---------- exposure (analytic eye adaptation) ----------
// Target: the base exposure by day, rising smoothly through sunset to 6x at night (so moonlight and stars read).
// From orbit a sunlit limb is nearly always in view, so the night boost shrinks with orbitness.
// The applied value follows the target in log space: brightening (eyes adjusting to the dark) is slower than darkening.
function exposureTarget(sunUp, o) {
  // night = how far the sun is below this camera's *visible* horizon, which dips with altitude on this small planet
  const dip = Math.acos(Math.min(1, PLANET_R / (PLANET_R + Math.max(0, rig.altitude))));
  const sunEl = Math.asin(Math.max(-1, Math.min(1, sunUp))) + dip;
  const night = smooth(-0.05, -0.35, sunEl);
  return state.exposure * Math.pow(1 + 5 * night, 1 - 0.75 * o);
}
let exposureLog = null;
function updateExposure(sunUp, o, dt) {
  const tgt = Math.log(exposureTarget(sunUp, o));
  if (exposureLog === null || state.still) exposureLog = tgt;
  else {
    const tau = tgt > exposureLog ? 1.4 : 0.45;
    exposureLog += (tgt - exposureLog) * (1 - Math.exp(-dt / tau));
  }
  state.exposureNow = Math.exp(exposureLog);
  return state.exposureNow;
}

// ---------- frame ----------
let prev = performance.now(), lastView = null, frameNo = 0;
let capturing = false;   // renderStill in progress: the frame loop pauses (camera, time and GL state stay put)
const app = { state, rig, gl, canvas, params, sunDir, onFrame: [], started: false, perf };
window.__planet = app;
const ui = initUI(app);
const audio = createAudio(app);
app.audio = audio;

const HALTON = [];
for (let i = 1; i <= 16; i++) {
  const h = (b) => { let f = 1, r = 0, n = i; while (n > 0) { f /= b; r += f * (n % b); n = Math.floor(n / b); } return r; };
  HALTON.push([h(2) - 0.5, h(3) - 0.5]);
}

function viewNow(sunUp) {
  const o = rig.orbitness();
  const fov = (state.fovNear + (state.fovFar - state.fovNear) * o) * Math.PI / 180;
  return {
    pos: rig.pos.slice(), r: rig.r.slice(), u: rig.u.slice(), f: rig.f.slice(), alt: rig.altitude,
    focal: 1 / Math.tan(fov / 2), sd: sunDir(), time: state.time, exposure: state.exposureNow, o, sunUp,
  };
}
function sameView(a, b) {
  if (!a || !b) return false;
  const d = (x, y) => Math.abs(x[0] - y[0]) + Math.abs(x[1] - y[1]) + Math.abs(x[2] - y[2]);
  return d(a.pos, b.pos) < 1e-3 && d(a.f, b.f) < 1e-7 && d(a.u, b.u) < 1e-7 && a.focal === b.focal;
}

function frame(now) {
  requestAnimationFrame(frame);
  gov.raf(now);
  if (!G || G.lost || G.failed || gl.isContextLost()) return;
  if (!G.compiled) {
    if (!pollCompile()) return;
    prev = now;
    ui.ready?.();
  }
  if (capturing) return;
  if (!gov.due(now, prev)) return;
  const raw = (now - prev) / 1000;
  const dt = Math.min(0.1, raw);
  prev = now;

  timerPoll();
  gov.frame(raw, now / 1000, rig.altitude);
  if (!state.still) state.time += dt;
  state.sunAngle += state.sunSpeed * dt;
  if (!state.still || state.time === 0) { state.fps = state.fps * 0.9 + (dt > 0 ? 1 / dt : 0) * 0.1; }

  if (!G.lutDone) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, G.lut.fbo);
    gl.viewport(0, 0, TRANS_LUT_W, TRANS_LUT_H);
    gl.useProgram(G.lutProg.p);
    gl.bindVertexArray(G.vao);
    gl.uniform1ui(G.lutProg.u.uSeed, state.seed);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    G.lutDone = true;
  }

  rig.update(dt);
  resizeCanvas();
  for (const f of app.onFrame) f(dt);

  const sd = sunDir();
  const len = Math.hypot(...rig.pos);
  const sunUp = (rig.pos[0] * sd[0] + rig.pos[1] * sd[1] + rig.pos[2] * sd[2]) / len;
  updateExposure(sunUp, rig.orbitness(), dt);
  const v = viewNow(sunUp);
  rig.focal = v.focal;

  const ow = canvas.width, oh = canvas.height;
  const rw = Math.max(1, Math.round(ow * state.scale)), rh = Math.max(1, Math.round(oh * state.scale));
  const rt = ensureTargets(rw, rh);
  // temporal accumulation only while nothing moves (interactive mode; ?still renders stay deterministic)
  const still = !state.still && !params.noaccum && !rig.busy && sameView(v, lastView);
  lastView = v;
  if (!still) rt.accum = 0;
  frameNo = (frameNo + 1) % 4096;
  const jit = still ? HALTON[rt.accum % HALTON.length] : [0, 0];

  const q = timerBegin();
  gl.disable(gl.SCISSOR_TEST);
  gl.bindFramebuffer(gl.FRAMEBUFFER, rt.scene.fbo);
  draw(v, rw, rh, state.quality, jit, state.still ? 0 : frameNo);
  let src = rt.scene;
  if (still) {
    const dst = rt.accum % 2 ? rt.h1 : rt.h0, hist = rt.accum % 2 ? rt.h0 : rt.h1;
    const floor = G.histFmt === 'rgba16f' ? 0.1 : 0.2;
    const blend = rt.accum === 0 ? 1 : Math.max(1 / (rt.accum + 1), floor);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, rw, rh);
    gl.useProgram(G.resolveProg.p);
    gl.bindVertexArray(G.vao);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, rt.scene.tex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, hist.tex);
    gl.uniform1i(G.resolveProg.u.uCur, 0);
    gl.uniform1i(G.resolveProg.u.uHist, 1);
    gl.uniform1f(G.resolveProg.u.uBlend, blend);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    src = dst;
    rt.accum++;
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, ow, oh);
  gl.useProgram(G.upProg.p);
  gl.bindVertexArray(G.vao);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src.tex);
  const U = G.upProg.u;
  gl.uniform1i(U.uSrc, 0);
  gl.uniform2f(U.uSrcSize, rw, rh);
  gl.uniform2f(U.uDstSize, ow, oh);
  gl.uniform1f(U.uSharp, clamp((ow / rw - 1) * 0.5, 0, 0.4));
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  timerEnd(q);

  app.frames = (app.frames || 0) + 1;
  Object.assign(perf, {
    fps: raw > 1e-3 ? perf.fps * 0.9 + 0.1 / raw : perf.fps, frameMs: raw * 1000, scale: state.scale, quality: state.quality, rw, rh, ow, oh,
    mode: still ? 'accumulate' : (rw === ow ? 'full' : 'upscale'), accum: rt.accum, exposure: state.exposureNow, histFmt: G.histFmt,
  });
}

// Draws the planet into whatever framebuffer is bound (scissor state is left to the caller).
function draw(v, w, h, quality, pixOff, frame) {
  const P = G.mainProg, u = P.u;
  gl.viewport(0, 0, w, h);
  gl.useProgram(P.p);
  gl.bindVertexArray(G.vao);
  gl.uniform2f(u.uRes, w, h);
  gl.uniform1f(u.uTime, v.time);
  gl.uniform3fv(u.uCamPos, v.pos);
  gl.uniform3fv(u.uCamR, v.r);
  gl.uniform3fv(u.uCamU, v.u);
  gl.uniform3fv(u.uCamF, v.f);
  gl.uniform1f(u.uFocal, v.focal);
  gl.uniform1f(u.uCamAlt, v.alt);
  gl.uniform3fv(u.uSunDir, v.sd);
  gl.uniform1f(u.uExposure, v.exposure);
  gl.uniform1i(u.uQuality, quality);
  gl.uniform1ui(u.uSeed, state.seed);
  if (u.uPixOff) gl.uniform2f(u.uPixOff, pixOff[0], pixOff[1]);
  if (u.uFrame) gl.uniform1f(u.uFrame, frame);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, G.lut.tex);
  gl.uniform1i(u.uTransLUT, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

// Render the current view at a given size and best quality, in tiles so phones don't time out.
// Resolves to a PNG Blob. Used by the UI's photo button. The view is frozen when it starts, and the frame loop
// pauses (capturing) until it is done, so nothing else draws or moves between tiles.
app.renderStill = async function (W, H) {
  if (!G || !G.compiled || G.lost) throw new Error('not ready');
  if (capturing) throw new Error('a photo is already being rendered');
  const sd = sunDir();
  const sunUp = (rig.pos[0] * sd[0] + rig.pos[1] * sd[1] + rig.pos[2] * sd[2]) / Math.hypot(...rig.pos);
  const v = viewNow(sunUp);
  const g = G;
  const tgt = makeTarget(W, H, gl.RGBA8, gl.UNSIGNED_BYTE);
  const px = new Uint8Array(W * H * 4);
  const tile = 512;
  capturing = true;
  try {
    for (let y = 0; y < H; y += tile) {
      for (let x = 0; x < W; x += tile) {
        if (g !== G || g.lost) throw new Error('context lost');
        // set our own GL state for every tile (belt and braces: the frame loop is paused while capturing)
        gl.bindFramebuffer(gl.FRAMEBUFFER, tgt.fbo);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(x, y, Math.min(tile, W - x), Math.min(tile, H - y));
        draw(v, W, H, 2, [0, 0], 0);
        gl.disable(gl.SCISSOR_TEST);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, tgt.fbo);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  } finally {
    capturing = false;
    prev = performance.now();   // the pause is not a slow frame
    lastView = null;
    gov.reset(4);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (g === G) freeTarget(tgt);
  }
  const c2 = document.createElement('canvas');
  c2.width = W; c2.height = H;
  const ctx = c2.getContext('2d');
  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) img.data.set(px.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
  ctx.putImageData(img, 0, 0);
  return await new Promise((r) => c2.toBlob(r, 'image/png'));
};

// Debug helper: synchronously times the passes of the current view (blocks; for the console only).
// app.perf.bench(5) -> { main, resolve, upscale } in ms per frame at the current render/canvas size.
perf.bench = function (n = 5) {
  if (!G || !G.compiled || !G.rt) return null;
  const rt = G.rt, v = lastView, px = new Uint8Array(4);
  const sync = () => { gl.bindFramebuffer(gl.FRAMEBUFFER, rt.scene.fbo); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); };
  const time = (fn) => { sync(); const t = performance.now(); for (let i = 0; i < n; i++) { fn(); sync(); } return (performance.now() - t) / n; };
  const main = time(() => { gl.bindFramebuffer(gl.FRAMEBUFFER, rt.scene.fbo); draw(v, rt.w, rt.h, state.quality, [0, 0], 0); });
  const resolve = time(() => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt.h0.fbo); gl.viewport(0, 0, rt.w, rt.h); gl.useProgram(G.resolveProg.p);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, rt.h1.tex); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, rt.scene.tex);
    gl.uniform1i(G.resolveProg.u.uCur, 0); gl.uniform1i(G.resolveProg.u.uHist, 1); gl.uniform1f(G.resolveProg.u.uBlend, 0.5);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  });
  const upscale = time(() => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, canvas.width, canvas.height); gl.useProgram(G.upProg.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, rt.scene.tex);
    gl.uniform1i(G.upProg.u.uSrc, 0); gl.uniform2f(G.upProg.u.uSrcSize, rt.w, rt.h); gl.uniform2f(G.upProg.u.uDstSize, canvas.width, canvas.height); gl.uniform1f(G.upProg.u.uSharp, 0.3);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  });
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  lastView = null;   // the history was overwritten
  const r = (x) => Math.round(x * 100) / 100;
  return { main: r(main), resolve: r(resolve), upscale: r(upscale), render: `${rt.w}x${rt.h}`, canvas: `${canvas.width}x${canvas.height}`, quality: state.quality };
};

// ---------- debug overlay (#debug) ----------
let dbg = null;
function showDebugError(err) {
  if (dbg) { dbg.textContent = 'shader error (see console)\n' + err.slice(0, 600); dbg.style.color = '#f88'; }
}
if (params.debug) {
  dbg = document.createElement('pre');
  dbg.style.cssText = 'position:fixed;left:8px;top:8px;margin:0;padding:4px 6px;font:11px/1.35 ui-monospace,Menlo,monospace;color:#cfe;background:#0009;border-radius:4px;pointer-events:none;z-index:99;white-space:pre';
  document.body.appendChild(dbg);
  setInterval(() => {
    if (!G || G.failed) return;
    const p = perf;
    dbg.textContent = G.compiled
      ? `${p.fps.toFixed(0)} fps  ${p.frameMs.toFixed(1)} ms${p.timer ? `  gpu ${p.gpuMs.toFixed(1)} ms` : ''}\n` +
        `target ${p.targetFps} of ${p.refreshHz} Hz\n` +
        `scale ${p.scale.toFixed(2)}  q${p.quality}  ${p.rw}x${p.rh} -> ${p.ow}x${p.oh}\n` +
        `${p.mode}${p.mode === 'accumulate' ? ' ' + p.accum : ''}  exp ${p.exposure.toFixed(3)}  drops ${p.drops}`
      : `compiling shaders... ${Math.round(performance.now() - G.t0)} ms`;
  }, 250);
}

// ---------- context loss ----------
canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  if (G) G.lost = true;
  console.warn('[planet] WebGL context lost; waiting for it to be restored');
});
canvas.addEventListener('webglcontextrestored', () => {
  console.warn('[planet] WebGL context restored; rebuilding');
  G = createGL();
  lastView = null;
  gov.reset(8);
});
addEventListener('hashchange', () => location.reload());
addEventListener('resize', () => gov.reset(4));
document.addEventListener('visibilitychange', () => gov.reset(6));

// Start compiling after the first paint so the page (and the UI) shows up before the driver gets busy.
gov.init();
requestAnimationFrame(() => setTimeout(() => {
  G = createGL();
  requestAnimationFrame(frame);
}, 0));
