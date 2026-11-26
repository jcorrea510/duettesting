// UI: intro hook, controls, altitude readout, photo / share, explainer panel, credit.
// OWNER: UI agent.
//
// CONTRACT: export function initUI(app) -> { ready() }  (ready is called once the shaders are compiled)
// app: { state, rig, gl, canvas, params, sunDir, onFrame[], audio, renderStill(w,h) }
// Markup and styles live in index.html. Body classes used as state:
//   ready (shaders compiled), began (intro dismissed), chrome-on (controls shown), idle (chrome faded),
//   menu (info open), keys-on (desktop key hints), glfail (shader build failed; nogl is set by main.js).

const $ = (id) => document.getElementById(id);
const body = document.body;
const mq = (q) => typeof matchMedia === 'function' && matchMedia(q).matches;
const isTouch = () => mq('(pointer: coarse)') || (!mq('(hover: hover)') && 'ontouchstart' in window);
const ORBIT_ALT = 165000;
const IDLE_MS = 4200;

export function initUI(app) {
  const { rig, canvas } = app;
  const el = {
    land: $('land'), orbit: $('orbit'), snd: $('snd'), pho: $('pho'), shr: $('shr'), inf: $('inf'),
    credit: $('credit'), altv: $('altv'), altu: $('altu'), altm: $('altm'),
    toast: $('toast'), live: $('live'), info: $('info'), scrim: $('scrim'),
    kb: $('kb'), kbs: $('kbs'), stat: $('stat'),
  };
  const toastText = el.toast?.querySelector('.tt');
  let isReady = false, began = false, chromeOn = false, menuOpen = false, photoBusy = false;
  let userMuted = false;   // once the user turns sound off, nothing turns it back on except the Sound button
  let idleTimer = 0, toastTimer = 0, toastAction = null, lastFocus = null;

  // ---------- gestures: no page zoom on iOS ----------
  for (const t of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(t, (e) => e.preventDefault(), { passive: false });
  document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });

  // A shader build failure throws inside the frame loop before ready(): show a calm message instead of a loader forever.
  addEventListener('error', (e) => {
    if (!isReady && /shader|webgl|program/i.test(String(e.message || e.error?.message || ''))) body.classList.add('glfail');
  });

  // Start the soundscape from inside a user gesture (iOS only unlocks audio there), unless the user muted it.
  function autoSound() {
    if (userMuted || !app.audio || app.audio.on) return;
    try { app.audio.start(); } catch (e) { /* audio is optional */ }
    syncSound();
  }

  // ---------- intro ----------
  function begin() {
    if (began || !isReady) return;
    began = true;
    body.classList.add('began');
    showChrome();
    if (!isTouch()) {
      body.classList.add('keys-on');
      setTimeout(() => body.classList.remove('keys-on'), 9000);
    }
    wake();
  }
  function showChrome() {
    if (chromeOn) return;
    chromeOn = true;
    body.classList.add('chrome-on');
  }

  // "Tap anywhere to fall in": the camera dives to a tapped point on the planet. If the first tap misses the
  // planet (lands on space), fly to a coastline instead so the promise always holds.
  let down = null;
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  canvas.addEventListener('pointerup', (e) => {
    const d = down; down = null;
    if (!d || began || !isReady) { if (isReady) begin(); return; }
    const tap = Math.hypot(e.clientX - d.x, e.clientY - d.y) < 8 && performance.now() - d.t < 450;
    if (tap && !rig.busy && rig.orbitness() > 0.5) rig.land();
    if (tap) autoSound();   // the "fall in" tap brings the sound in, in the same gesture
    begin();
  });

  const prevInteract = rig.onInteract;
  rig.onInteract = () => { prevInteract?.(); wakeSoon(); };

  // ---------- idle: fade chrome after a few quiet seconds, back on any input ----------
  let wakeQueued = false;
  function wakeSoon() { if (!wakeQueued) { wakeQueued = true; requestAnimationFrame(() => { wakeQueued = false; wake(); }); } }
  function wake() {
    body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(goIdle, IDLE_MS);
  }
  function goIdle() {
    const hovering = document.querySelector('#bar:hover, #credit:hover');
    if (!began || menuOpen || photoBusy || el.toast?.classList.contains('show') || hovering || document.querySelector('#bar :focus-visible')) {
      idleTimer = setTimeout(goIdle, 1500);
      return;
    }
    body.classList.add('idle');
  }
  for (const t of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart']) {
    addEventListener(t, (e) => {
      if (!isReady) return;
      if (!began && (t === 'keydown' || t === 'wheel')) begin();
      if (t === 'pointermove' && e.pointerType === 'mouse' && !e.movementX && !e.movementY) return;
      wakeSoon();
    }, { passive: true, capture: true });
  }

  // ---------- toast ----------
  function toast(text, { action = null, ms = 2600, busy = false } = {}) {
    if (!el.toast) return;
    clearTimeout(toastTimer);
    toastText.textContent = text;
    toastAction = action;
    el.toast.classList.toggle('act', !!action);
    el.toast.classList.toggle('busy', busy);
    el.toast.tabIndex = action ? 0 : -1;
    el.toast.classList.add('show');
    body.classList.add('toasting');
    if (el.live) el.live.textContent = text;
    if (ms > 0) toastTimer = setTimeout(hideToast, ms);
    wake();
  }
  function hideToast() {
    clearTimeout(toastTimer);
    el.toast?.classList.remove('show', 'busy');
    body.classList.remove('toasting');
    toastAction = null;
  }
  el.toast?.addEventListener('click', () => { const a = toastAction; if (!a) return; hideToast(); a(); });

  // ---------- controls ----------
  function land() {
    begin();
    autoSound();
    if (!rig.land()) toast('No coastline in view. Try again from orbit');
  }
  function toOrbit() {
    begin();
    if (typeof rig.toOrbit === 'function') rig.toOrbit();
    else rig.diveTo(rig.groundDir, { alt: rig.orbitAlt || ORBIT_ALT, duration: 7 });
  }
  function sound() {
    begin();
    app.audio?.toggle?.();   // synchronous, inside the user gesture (iOS needs that to unlock audio)
    userMuted = !app.audio?.on;
    syncSound();
    setTimeout(syncSound, 250);
  }
  function syncSound() {
    const on = !!app.audio?.on;
    if (el.snd && el.snd.getAttribute('aria-pressed') !== String(on)) el.snd.setAttribute('aria-pressed', String(on));
  }
  function viewURL() {
    let h = rig.toHash();
    if (app.state.seed !== 1) h += '&seed=' + app.state.seed;
    h += '&sun=' + (app.state.sunAngle % (Math.PI * 2)).toFixed(3);
    return location.origin + location.pathname + '#' + h;
  }
  async function share() {
    begin();
    const url = viewURL();
    if (isTouch() && navigator.share) {
      try { await navigator.share({ title: 'Halcyon', text: "A planet that doesn't exist.", url }); return; }
      catch (e) { if (e && e.name === 'AbortError') return; }
    }
    if (await copyText(url)) toast('Link copied. It opens on this exact view');
    else toast(url, { ms: 8000 });
  }
  async function copyText(s) {
    try { await navigator.clipboard.writeText(s); return true; } catch (e) { /* fall through */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = s; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;opacity:0;left:0;top:0';
      document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, s.length);
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }

  // ---------- photo ----------
  function photoSize() {
    const gl = app.gl;
    const max = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) || 4096, 4096);
    const long = Math.min(3840, max);
    const a = (canvas.clientWidth || 16) / (canvas.clientHeight || 9);
    let w, h;
    if (a >= 1) { w = long; h = long / a; } else { h = long; w = long * a; }
    return [Math.max(2, Math.round(w / 2) * 2), Math.max(2, Math.round(h / 2) * 2)];
  }
  async function photo() {
    begin();
    if (photoBusy || !app.renderStill) return;
    photoBusy = true;
    el.pho?.setAttribute('aria-busy', 'true');
    if (el.pho) el.pho.disabled = true;
    toast('Developing photo', { busy: true, ms: 0 });
    try {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); // let the toast paint first
      const [W, H] = photoSize();
      const blob = await app.renderStill(W, H);
      if (!blob) throw new Error('empty');
      const name = 'halcyon-' + new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '') + '.png';
      const file = typeof File === 'function' ? new File([blob], name, { type: 'image/png' }) : null;
      const canShareFile = isTouch() && file && navigator.canShare && navigator.share && (() => { try { return navigator.canShare({ files: [file] }); } catch (e) { return false; } })();
      if (canShareFile) {
        // iOS only opens the share sheet from a fresh tap, so hand the user a button.
        toast('Photo ready. Tap to save', {
          ms: 30000,
          action: () => navigator.share({ files: [file] }).catch((e) => { if (e?.name !== 'AbortError') download(blob, name); }),
        });
      } else if (isTouch()) {
        toast('Photo ready. Tap to save', { ms: 30000, action: () => download(blob, name) });
      } else {
        download(blob, name);
        toast(`Photo saved · ${W} × ${H}`);
      }
    } catch (e) {
      console.warn('photo failed', e);
      toast("Couldn't develop the photo on this device");
    } finally {
      photoBusy = false;
      el.pho?.removeAttribute('aria-busy');
      if (el.pho) el.pho.disabled = false;
    }
  }
  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  // ---------- info panel ----------
  function openInfo() {
    begin();
    if (menuOpen) return;
    menuOpen = true;
    lastFocus = document.activeElement;
    body.classList.add('menu');
    el.info?.setAttribute('aria-hidden', 'false');
    el.inf?.setAttribute('aria-expanded', 'true');
    wake();
    measureCode();
    setTimeout(() => el.info?.querySelector('.x')?.focus({ preventScroll: true }), 60);
  }
  function closeInfo() {
    if (!menuOpen) return;
    menuOpen = false;
    body.classList.remove('menu');
    el.info?.setAttribute('aria-hidden', 'true');
    el.inf?.setAttribute('aria-expanded', 'false');
    if (lastFocus && lastFocus.focus && lastFocus !== document.body) lastFocus.focus({ preventScroll: true });
    wake();
  }
  el.info?.querySelector('.x')?.addEventListener('click', closeInfo);
  el.scrim?.addEventListener('click', closeInfo);

  // Real size of the code, measured by fetching the very files this page loaded (from cache) and summing bytes.
  let measured = null;
  function measureCode() {
    if (measured) return measured;
    measured = (async () => {
      const urls = new Set([location.href.split('#')[0]]);
      try {
        for (const e of performance.getEntriesByType('resource')) {
          if (/\/src\/planet\/[^?#]*\.js(\?|$)/.test(e.name)) urls.add(e.name.split('#')[0]);
        }
      } catch (e) { /* no resource timing */ }
      const base = import.meta.url;
      for (const f of ['main.js', 'camera.js', 'ui.js', 'audio.js', 'terrain-cpu.js', 'vec.js',
        'glsl/common.js', 'glsl/atmosphere.js', 'glsl/clouds.js', 'glsl/terrain.js', 'glsl/ocean.js', 'glsl/extras.js', 'glsl/composite.js']) {
        urls.add(new URL(f, base).href);
      }
      const bufs = await Promise.all([...urls].map((u) => fetch(u, { cache: 'force-cache' })
        .then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null)));
      const parts = bufs.filter(Boolean);
      const raw = parts.reduce((s, b) => s + b.byteLength, 0);
      if (!raw) throw new Error('nothing measured');
      let gz = 0;
      if (typeof CompressionStream === 'function') {
        try {
          const cs = new Blob(parts).stream().pipeThrough(new CompressionStream('gzip'));
          gz = (await new Response(cs).arrayBuffer()).byteLength;
        } catch (e) { gz = 0; }
      }
      return { raw, gz, files: parts.length };
    })();
    measured.then(({ raw, gz, files }) => {
      const kb = (n) => Math.max(1, Math.round(n / 1024));
      el.kb.innerHTML = `${kb(raw)}<small>KB</small>`;
      el.kbs.textContent = `The whole planet: ${files} files of HTML, JavaScript and GLSL shaders` +
        (gz ? `, ${kb(gz)} KB compressed` : '') + '. No libraries, no build step.';
      el.stat?.classList.remove('pending');
    }).catch(() => { el.stat?.remove(); });
    return measured;
  }

  // ---------- wiring ----------
  const on = (b, f) => b?.addEventListener('click', (e) => { e.stopPropagation(); f(); });
  on(el.land, land); on(el.orbit, toOrbit); on(el.snd, sound); on(el.pho, photo); on(el.shr, share);
  on(el.inf, () => (menuOpen ? closeInfo() : openInfo()));
  on(el.credit, openInfo);

  addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || !isReady) return;
    const k = e.key.toLowerCase();
    if (k === 'escape') { if (menuOpen) closeInfo(); else hideToast(); return; }
    if (e.target?.closest?.('#info') && k !== 'i') return;
    if (e.repeat) return;
    if (k === 'l') land();
    else if (k === 'o') toOrbit();
    else if (k === 'm') sound();
    else if (k === 'p') photo();
    else if (k === 'i') (menuOpen ? closeInfo() : openInfo());
    else return;
    body.classList.remove('keys-on');
  });

  // Focus stays inside the info dialog while it is open.
  el.info?.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const f = [...el.info.querySelectorAll('button, a[href]')];
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  // ---------- per-frame: altitude instrument, contextual Land / Orbit ----------
  let lastAlt = '', lastUnit = '', lastTape = -1, showLand = true, showOrbit = false, frameN = 0;
  const LOG_TOP = Math.log(250000);
  function fmt(m) {
    if (m >= 100000) return [String(Math.round(m / 1000)), 'km'];
    if (m >= 10000) return [(m / 1000).toFixed(1), 'km'];
    if (m >= 1000) return [(m / 1000).toFixed(2), 'km'];
    if (m >= 10) return [String(Math.round(m)), 'm'];
    return [Math.max(0, m).toFixed(1), 'm'];
  }
  app.onFrame.push(() => {
    if (!isReady) return;
    const agl = Math.max(0, rig.altitude - Math.max(0, rig.groundH || 0));
    const [v, u] = fmt(agl);
    if (v !== lastAlt) { el.altv.textContent = v; lastAlt = v; }
    if (u !== lastUnit) { el.altu.textContent = u; lastUnit = u; }
    const tape = Math.round(Math.min(1, Math.max(0, Math.log(Math.max(agl, 1)) / LOG_TOP)) * 830) / 10;
    if (tape !== lastTape) { el.altm.style.transform = `translateX(${tape}px)`; lastTape = tape; }

    // contextual buttons, with hysteresis so they don't flicker
    const o = rig.orbitness();
    const sl = showLand ? agl > 25 : agl > 60;
    const so = showOrbit ? (o < 0.985 || rig.busy) : (o < 0.95);
    if (sl !== showLand) { showLand = sl; el.land.hidden = !sl; }
    if (so !== showOrbit) { showOrbit = so; el.orbit.hidden = !so; }
    const orbitPrimary = !showLand;
    if (el.orbit.classList.contains('primary') !== orbitPrimary) {
      el.orbit.classList.toggle('primary', orbitPrimary);
    }
    if ((++frameN & 15) === 0) syncSound();
  });

  return {
    ready() {
      isReady = true;
      body.classList.add('ready');
      // the title plays first; the controls arrive once it has settled
      setTimeout(showChrome, 5200);
      // a shared link (#cam=...) lands somewhere specific: skip the intro there
      if (app.params?.cam) setTimeout(begin, 2600);
    },
  };
}
