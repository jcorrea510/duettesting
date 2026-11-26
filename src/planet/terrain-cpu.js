// JavaScript mirror of terrainHeight() in glsl/terrain.js, bit-for-bit where possible.
// OWNER: terrain agent (must change together with the GLSL).
export const PLANET_R = 60000;

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

const out = new Float64Array(4);
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
  out[0] = -1 + 2 * v;
  out[1] = 2 * dux * (k1 + k4 * uy + k6 * uz + k7 * uy * uz);
  out[2] = 2 * duy * (k2 + k5 * uz + k4 * ux + k7 * uz * ux);
  out[3] = 2 * duz * (k3 + k6 * ux + k5 * uy + k7 * ux * uy);
  return out;
}
const noise3 = (x, y, z) => noised3(x, y, z)[0];

// GLSL mat3 is column-major: M3 * v = col0 * v.x + col1 * v.y + col2 * v.z
const C0 = [0.00, 0.80, 0.60], C1 = [-0.80, 0.36, -0.48], C2 = [-0.60, -0.48, 0.64];
function m3(x, y, z) {
  return [C0[0] * x + C1[0] * y + C2[0] * z, C0[1] * x + C1[1] * y + C2[1] * z, C0[2] * x + C1[2] * y + C2[2] * z];
}
const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

export function continentField(dx, dy, dz) {
  const px = dx * 2.2, py = dy * 2.2, pz = dz * 2.2;
  const a = m3(px, py, pz);
  const b = m3(...m3(px, py, pz));
  return 0.6 * noise3(px, py, pz)
    + 0.3 * noise3(a[0] * 2.1 + 3.1, a[1] * 2.1 + 1.7, a[2] * 2.1 - 2.3)
    + 0.1 * noise3(b[0] * 4.3, b[1] * 4.3, b[2] * 4.3);
}

/** Height above sea level (metres) at unit direction (dx, dy, dz). */
export function terrainHeight(dx, dy, dz, oct = 7) {
  const c = continentField(dx, dy, dz);
  const s = PLANET_R / 1100;
  let px = dx * s, py = dy * s, pz = dz * s;
  let a = 0, b = 1, gx = 0, gy = 0, gz = 0;
  for (let i = 0; i < oct; i++) {
    const n = noised3(px, py, pz);
    gx += n[1]; gy += n[2]; gz += n[3];
    a += b * n[0] / (1 + gx * gx + gy * gy + gz * gz);
    b *= 0.5;
    const r = m3(px, py, pz);
    px = r[0] * 2.02; py = r[1] * 2.02; pz = r[2] * 2.02;
  }
  const land = smooth(-0.05, 0.45, c);
  let relief = 0.5 + 0.5 * a;
  relief *= relief * (1.6 - 0.6 * relief);
  return (-260 + (12 + 260) * land) + relief * (30 + 900 * land * land) - 20;
}
