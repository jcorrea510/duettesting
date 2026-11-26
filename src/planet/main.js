// Planet: WebGL2 setup, shader assembly, frame loop and adaptive resolution.
// OWNER: main session (performance agent may tune adapt()).
import { COMMON } from './glsl/common.js';
import { ATMOSPHERE, TRANS_LUT_FS, TRANS_LUT_W, TRANS_LUT_H } from './glsl/atmosphere.js';
import { CLOUDS } from './glsl/clouds.js';
import { TERRAIN } from './glsl/terrain.js';
import { OCEAN } from './glsl/ocean.js';
import { EXTRAS } from './glsl/extras.js';
import { COMPOSITE } from './glsl/composite.js';
import { terrainHeight, setSeed, PLANET_R } from './terrain-cpu.js';
import { CameraRig } from './camera.js';
import { initUI } from './ui.js';
import { createAudio } from './audio.js';

const canvas = document.getElementById('c');
const VS = `#version 300 es
void main() { vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;

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

const state = {
  seed: Math.max(1, Math.floor(num(params.seed, 1))) >>> 0,
  sunAngle: num(params.sun, 0.9),        // radians around the polar axis
  sunTilt: 0.22,
  sunSpeed: params.still ? 0 : 0.0035,   // rad/s: the day goes by slowly
  still: !!params.still,
  scale: Math.min(1, Math.max(0.2, num(params.scale, 0.6))),
  quality: params.q !== undefined ? Math.max(0, Math.min(2, num(params.q, 1) | 0)) : 1,
  fps: 0,
  exposure: 0.14,
  time: num(params.time, 0),
  fovNear: 55, fovFar: 48,
};
setSeed(state.seed);

// ---------- GL ----------
const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
if (!gl) {
  document.body.classList.add('nogl');
  throw new Error('WebGL2 unavailable');
}
const parallel = gl.getExtension('KHR_parallel_shader_compile');

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  return s;
}
function link(fsSrc) {
  const p = gl.createProgram();
  const v = compile(gl.VERTEX_SHADER, VS), f = compile(gl.FRAGMENT_SHADER, fsSrc);
  gl.attachShader(p, v); gl.attachShader(p, f);
  gl.linkProgram(p);
  return { p, v, f, src: fsSrc };
}
function ready(prog) {
  return !parallel || gl.getProgramParameter(prog.p, parallel.COMPLETION_STATUS_KHR);
}
function check(prog) {
  if (!gl.getProgramParameter(prog.p, gl.LINK_STATUS)) {
    const log = gl.getShaderInfoLog(prog.f) || gl.getProgramInfoLog(prog.p);
    const lines = prog.src.split('\n');
    const m = /0:(\d+)/.exec(log || '');
    const ctx = m ? lines.slice(Math.max(0, m[1] - 4), +m[1] + 2).map((l, i) => (Math.max(1, m[1] - 3) + i) + ': ' + l).join('\n') : '';
    console.error('shader error\n' + log + '\n' + ctx);
    throw new Error('shader failed: ' + log);
  }
  const u = {};
  const n = gl.getProgramParameter(prog.p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const a = gl.getActiveUniform(prog.p, i); u[a.name] = gl.getUniformLocation(prog.p, a.name); }
  prog.u = u;
  return prog;
}

const lutProg = link(COMMON + ATMOSPHERE + TRANS_LUT_FS);
const mainSrc = COMMON + ATMOSPHERE + CLOUDS + TERRAIN + OCEAN + EXTRAS + COMPOSITE;
const mainProg = link(mainSrc);
const vao = gl.createVertexArray();

// transmittance LUT target
const lutTex = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, lutTex);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, TRANS_LUT_W, TRANS_LUT_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
const lutFbo = gl.createFramebuffer();
gl.bindFramebuffer(gl.FRAMEBUFFER, lutFbo);
gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, lutTex, 0);
gl.bindFramebuffer(gl.FRAMEBUFFER, null);
let lutDone = false;

// ---------- camera, sun ----------
function sunDir() {
  const a = state.sunAngle, t = state.sunTilt;
  return [Math.cos(a) * Math.cos(t), Math.sin(t), Math.sin(a) * Math.cos(t)];
}
const rig = new CameraRig({ canvas, heightAt: (x, y, z) => terrainHeight(x, y, z, 7), R: PLANET_R, sunDir });
if (params.cam) rig.setFromHash(params.cam);

// ---------- sizing / adaptive resolution ----------
const perf = { acc: 0, n: 0, vs: 1 / 60, last: 0, settle: 0, ceil: 1 };
function resize() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr * state.scale));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr * state.scale));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}
function adapt(dt) {
  if (state.still || params.scale) return;
  perf.vs = Math.min(perf.vs, Math.max(dt, 1 / 144));
  perf.acc += dt; perf.n++;
  if (perf.acc < 0.5) return;
  const avg = perf.acc / perf.n;
  perf.acc = 0; perf.n = 0;
  const target = Math.max(perf.vs, 1 / 60) * 1.12;
  if (avg > target * 1.25 && state.scale > 0.3) {
    state.scale = Math.max(0.3, state.scale * Math.sqrt(target / avg));
    perf.ceil = Math.min(perf.ceil, state.scale * 1.15);
  } else if (avg < target * 0.85 && state.scale < Math.min(1, perf.ceil)) {
    state.scale = Math.min(1, perf.ceil, state.scale * 1.08);
  }
  state.quality = state.scale <= 0.32 ? 0 : 1;
}

// ---------- frame ----------
let t0 = performance.now(), prev = t0;
let compiled = false;
const app = { state, rig, gl, canvas, params, sunDir, onFrame: [], started: false };
window.__planet = app;
const ui = initUI(app);
const audio = createAudio(app);
app.audio = audio;

function exposureFor(alt, sunUp) {
  // brighter at night so the moon/stars side is readable, a touch darker in space
  const night = 1 - Math.min(1, Math.max(0, (sunUp + 0.15) / 0.3));
  return state.exposure * (1 + night * 5);
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - prev) / 1000);
  prev = now;
  if (!compiled) {
    if (!ready(lutProg) || !ready(mainProg)) return;
    check(lutProg); check(mainProg);
    compiled = true;
    ui.ready?.();
  }
  if (!state.still) state.time += dt;
  state.sunAngle += state.sunSpeed * dt;
  if (!state.still || state.time === 0) { state.fps = state.fps * 0.9 + (dt > 0 ? 1 / dt : 0) * 0.1; }

  if (!lutDone) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, lutFbo);
    gl.viewport(0, 0, TRANS_LUT_W, TRANS_LUT_H);
    gl.useProgram(lutProg.p);
    gl.bindVertexArray(vao);
    gl.uniform1ui(lutProg.u.uSeed, state.seed);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    lutDone = true;
  }

  rig.update(dt);
  adapt(dt);
  resize();
  for (const f of app.onFrame) f(dt);

  const sd = sunDir();
  const up = rig.pos.map((v) => v / Math.hypot(...rig.pos));
  const sunUp = up[0] * sd[0] + up[1] * sd[1] + up[2] * sd[2];
  const o = rig.orbitness();
  const fov = (state.fovNear + (state.fovFar - state.fovNear) * o) * Math.PI / 180;
  const focal = 1 / Math.tan(fov / 2);
  rig.focal = focal;

  draw(sd, sunUp, focal, canvas.width, canvas.height, state.quality);
  app.frames = (app.frames || 0) + 1;
}

function draw(sd, sunUp, focal, w, h, quality) {
  gl.viewport(0, 0, w, h);
  gl.useProgram(mainProg.p);
  gl.bindVertexArray(vao);
  const u = mainProg.u;
  gl.uniform2f(u.uRes, w, h);
  gl.uniform1f(u.uTime, state.time);
  gl.uniform3fv(u.uCamPos, rig.pos);
  gl.uniform3fv(u.uCamR, rig.r);
  gl.uniform3fv(u.uCamU, rig.u);
  gl.uniform3fv(u.uCamF, rig.f);
  gl.uniform1f(u.uFocal, focal);
  gl.uniform1f(u.uCamAlt, rig.altitude);
  gl.uniform3fv(u.uSunDir, sd);
  gl.uniform1f(u.uExposure, exposureFor(rig.altitude, sunUp));
  gl.uniform1i(u.uQuality, quality);
  gl.uniform1ui(u.uSeed, state.seed);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, lutTex);
  gl.uniform1i(u.uTransLUT, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

// Render the current view at a given size and best quality, in tiles so phones don't time out.
// Resolves to a PNG Blob. Used by the UI's photo button.
app.renderStill = async function (W, H) {
  if (!compiled) throw new Error('not ready');
  const sd = sunDir();
  const up = rig.pos.map((v) => v / Math.hypot(...rig.pos));
  const sunUp = up[0] * sd[0] + up[1] * sd[1] + up[2] * sd[2];
  const fov = (state.fovNear + (state.fovFar - state.fovNear) * rig.orbitness()) * Math.PI / 180;
  const focal = 1 / Math.tan(fov / 2);
  const tex = gl.createTexture(), fbo = gl.createFramebuffer();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const px = new Uint8Array(W * H * 4);
  const tile = 512;
  try {
    gl.enable(gl.SCISSOR_TEST);
    for (let y = 0; y < H; y += tile) {
      for (let x = 0; x < W; x += tile) {
        gl.scissor(x, y, Math.min(tile, W - x), Math.min(tile, H - y));
        draw(sd, sunUp, focal, W, H, 2);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    gl.disable(gl.SCISSOR_TEST);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  } finally {
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo); gl.deleteTexture(tex);
  }
  const c2 = document.createElement('canvas');
  c2.width = W; c2.height = H;
  const ctx = c2.getContext('2d');
  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) img.data.set(px.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
  ctx.putImageData(img, 0, 0);
  return await new Promise((r) => c2.toBlob(r, 'image/png'));
};

canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
canvas.addEventListener('webglcontextrestored', () => location.reload());
addEventListener('hashchange', () => location.reload());
requestAnimationFrame(frame);
