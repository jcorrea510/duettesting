// JavaScript mirror of terrainHeight() in glsl/terrain.js. Same formulas, same order, same constants.
// OWNER: terrain agent (must change together with the GLSL).
import { COMMON } from './glsl/common.js';
export const PLANET_R = 60000;
// HMAX is read from the shared GLSL constants so the two copies can never disagree about the peak ceiling
export const HMAX = +(/HMAX\s*=\s*([0-9.]+)/.exec(COMMON) || [0, 1500])[1];

let seed = 1;
export function setSeed(s) { seed = s | 0; }

const imul = Math.imul;
function hash3(x, y, z) {
  const OFF = 1 << 22;
  const qx = (x + OFF) | 0, qy = (y + OFF) | 0, qz = (z + OFF) | 0;
  let n = (imul(qx, 1597334677) ^ imul(qy, 3812015801 | 0) ^ imul(qz, 2798796415 | 0) ^ imul(seed, 2654435761 | 0)) >>> 0;
  n = imul(n ^ (n >>> 16), 2246822519 | 0) >>> 0;
  n = (n ^ (n >>> 13)) >>> 0;
  n = imul(n, 3266489917 | 0) >>> 0;
  n = (n ^ (n >>> 16)) >>> 0;
  return n / 4294967295;
}

// returns [value in -1..1, d/dx, d/dy, d/dz] (a fresh array: callers keep several at once)
export function noised3(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const q = (f) => f * f * f * (f * (f * 6 - 15) + 10);
  const dq = (f) => 30 * f * f * (f * (f - 2) + 1);
  const ux = q(fx), uy = q(fy), uz = q(fz), dux = dq(fx), duy = dq(fy), duz = dq(fz);
  const a = hash3(ix, iy, iz), b = hash3(ix + 1, iy, iz), c = hash3(ix, iy + 1, iz), d = hash3(ix + 1, iy + 1, iz);
  const e = hash3(ix, iy, iz + 1), f1 = hash3(ix + 1, iy, iz + 1), g = hash3(ix, iy + 1, iz + 1), h = hash3(ix + 1, iy + 1, iz + 1);
  const k0 = a, k1 = b - a, k2 = c - a, k3 = e - a, k4 = a - b - c + d;
  const k5 = a - c - e + g, k6 = a - b - e + f1, k7 = -a + b + c - d + e - f1 - g + h;
  const v = k0 + k1 * ux + k2 * uy + k3 * uz + k4 * ux * uy + k5 * uy * uz + k6 * uz * ux + k7 * ux * uy * uz;
  return [-1 + 2 * v,
    2 * dux * (k1 + k4 * uy + k6 * uz + k7 * uy * uz),
    2 * duy * (k2 + k5 * uz + k4 * ux + k7 * uz * ux),
    2 * duz * (k3 + k6 * ux + k5 * uy + k7 * ux * uy)];
}
const noise3 = (x, y, z) => noised3(x, y, z)[0];

// GLSL mat3 is column-major: M3 * v = col0 * v.x + col1 * v.y + col2 * v.z
const C0 = [0.00, 0.80, 0.60], C1 = [-0.80, 0.36, -0.48], C2 = [-0.60, -0.48, 0.64];
function m3(v) {
  const [x, y, z] = v;
  return [C0[0] * x + C1[0] * y + C2[0] * z, C0[1] * x + C1[1] * y + C2[1] * z, C0[2] * x + C1[2] * y + C2[2] * z];
}
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const nz = (v) => noise3(v[0], v[1], v[2]);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;

// ---------------- macro field: continents, plates, coasts ----------------
// Fills the fields below for one direction (see terrainMacro in the GLSL; same names).
export const TM = { c: 0, coast: 0, land: 0, belt: 0, rng: 0, cliff: 0, base: 0, hillAmp: 0, mtnAmp: 0, volc: 0 };
export const TER_SEA = 0.12;
export function terrainMacro(dx, dy, dz) {
  const d = [dx, dy, dz];
  const p = mul(d, 2.2);
  const n0 = noised3(p[0], p[1], p[2]);
  const w = add(p, mul([n0[1], n0[2], n0[3]], 0.12));       // warp by the first octave's slope
  const a = m3(w);
  const b = m3(a);
  let c = 0.6 * n0[0] + 0.3 * nz(add(mul(a, 2.1), [3.1, 1.7, -2.3])) + 0.1 * nz(mul(b, 4.3));
  const e = add(mul(m3(b), 9.1), [-5.3, 2.9, 1.3]);
  c += 0.11 * nz(e) + 0.05 * nz(add(mul(m3(e), 2.13), [1.7, -4.1, 0.6]));
  c += 0.45 * smooth(0.8, 0.95, Math.abs(dy) + 0.06 * n0[0]);               // polar land under the ice caps
  // tectonics: plate boundaries are the zero lines of a low-frequency noise; they push up ranges on land
  // and broken island arcs at sea
  const tp = add(mul(m3(d), 3.3), add([7.3, -1.1, 4.9], mul([n0[1], n0[2], n0[3]], 0.05)));
  const belt = 1 - smooth(0.0, 0.36, Math.abs(nz(tp)));
  const rng = smooth(-0.3, 0.5, nz(add(mul(d, 6.3), [-2.2, 8.4, 3.3])));
  const spot = nz(add(mul(m3(m3(d)), 12.5), [4.4, -6.6, 2.2]));
  const belt2 = belt * belt * rng;
  c += 0.42 * belt2 * smooth(-0.2, 0.5, spot + 0.5 * rng - 0.25);
  const coast = c - TER_SEA;
  const land = smooth(0.0, 0.25, coast);
  const cliff = smooth(0.0, 0.45, spot) * (0.4 + 0.6 * rng);
  // sea floor: shallow shelf, then the deep
  const sea = -6 - 70 * smooth(0.0, 0.06, -coast) - 460 * smooth(0.05, 0.35, -coast);
  // land: beaches or cliffs at the shore, plains rising to interior uplands
  const cw = mix(0.02, 0.0025, cliff);
  const landH = 2.5 + 75 * cliff + 280 * smooth(0.0, 0.5, coast);
  let base = mix(sea, landH, smooth(-0.3 * cw, cw, coast));
  // volcanic island arcs where plate boundaries run through the sea
  const volc = belt2 * smooth(0.15, 0.75, spot);
  base += 330 * volc * (1 - land) * smooth(0.0, 0.08, -coast);
  // mountains: the plate-boundary ranges, plus massifs scattered through the interiors
  const mtn = Math.max(belt2, smooth(0.3, 0.9, rng) * smooth(-0.5, 0.2, spot));
  const mland = smooth(-0.03, 0.12, coast);
  base += 120 * mtn * mland;
  const mtnAmp = 1150 * mtn * mland + 330 * volc * (1 - land) + 40 * land;
  const hillAmp = 14 * smooth(-0.12, -0.02, coast) + 100 * land;   // no detail on the open sea floor: rays skip it
  Object.assign(TM, { c, coast, land, belt, rng, cliff, base, hillAmp, mtnAmp, volc });
  return TM;
}

// ---------------- detail: one octave loop, two sums ----------------
// hills: eroded fbm (each octave damped by the slope accumulated so far: smooth valleys, rough crests)
// mtn:   the same, but octaves 1-4 are sharpened toward ridged noise (knife-edge crests, branching gullies)
const DET = { hills: 0, mtn: 0 };
export const TER_BASE_WL = 3800, TER_LAC = 2.13;
export function terrainDetail(dx, dy, dz, oct) {
  const s = PLANET_R / TER_BASE_WL;
  let p = [dx * s, dy * s, dz * s];
  let hills = 0, mtn = 0, amp = 1, ampM = 1;
  let gx = 0, gy = 0, gz = 0;
  for (let i = 0; i < oct; i++) {
    const n = noised3(p[0], p[1], p[2]);
    gx += n[1]; gy += n[2]; gz += n[3];
    const gg = gx * gx + gy * gy + gz * gz;
    hills += amp * n[0] / (1 + 0.2 * gg);
    const sa = Math.sqrt(n[0] * n[0] + 0.0025);          // |n| with a slightly rounded crest
    const r = 1.05 - sa;
    const rn = r * r * 1.814 - 1;                       // ridged, back in -1..1
    const sh = i === 0 ? 0.3 : (i < 5 ? 0.9 : 0.5);
    mtn += ampM * (n[0] + (rn - n[0]) * sh) / (1 + 0.06 * gg);
    amp *= 0.5;
    ampM *= i === 0 ? 0.5 : 0.56;
    p = mul(m3(p), TER_LAC);
  }
  DET.hills = hills; DET.mtn = mtn;
  return DET;
}

const SOFTW = 200, SOFT0 = HMAX - 20 - SOFTW;   // tallest summits ease in below HMAX (the trace's ceiling)
export function terrainCompose(M, D) {
  let h = M.base + M.hillAmp * D.hills + M.mtnAmp * ((D.mtn + 0.9) * 0.7 - 0.2);
  if (h > SOFT0) h = SOFT0 + SOFTW * Math.tanh((h - SOFT0) / SOFTW);
  return h;
}

export function continentField(dx, dy, dz) { return terrainMacro(dx, dy, dz).c; }

/** Height above sea level (metres) at unit direction (dx, dy, dz). */
export function terrainHeight(dx, dy, dz, oct = 7) {
  const M = terrainMacro(dx, dy, dz);
  const D = terrainDetail(dx, dy, dz, oct);
  return terrainCompose(M, D);
}
