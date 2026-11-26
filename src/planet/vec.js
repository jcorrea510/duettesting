// Tiny 3-vector helpers (arrays of 3 numbers) and scalar easing used by the camera.
// OWNER: camera agent.
export const vadd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const vscale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const vlen = (a) => Math.hypot(a[0], a[1], a[2]);
export const vnorm = (a) => { const l = vlen(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const vmad = (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
export function slerp(a, b, t) {
  const d = Math.min(1, Math.max(-1, vdot(a, b)));
  const th = Math.acos(d);
  if (th < 1e-6) return a.slice();
  const s = Math.sin(th);
  return vadd(vscale(a, Math.sin((1 - t) * th) / s), vscale(b, Math.sin(t * th) / s));
}
// rotate v around unit axis k by angle a (Rodrigues)
export function rotAxis(v, k, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return vadd(vadd(vscale(v, c), vscale(vcross(k, v), s)), vscale(k, vdot(k, v) * (1 - c)));
}
// angle between two unit vectors (robust for small angles)
export const vangle = (a, b) => Math.atan2(vlen(vcross(a, b)), vdot(a, b));

// ---------- scalars ----------
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
// ease with zero slope at both ends whose fastest point is at t = 1/n (n = 2 is smoothstep; larger n = long soft tail)
export const easeTail = (t, n) => { t = clamp(t, 0, 1); return 1 - Math.pow(1 - t, n) * (1 + n * t); };

// ---------- tangent frames on the unit sphere (+Y is north) ----------
export function tangentFrame(g) {
  let east = vcross([0, 1, 0], g);
  if (vlen(east) < 1e-6) east = [1, 0, 0];
  east = vnorm(east);
  return { east, north: vcross(g, east) };
}
// unit tangent vector at g pointing along compass heading h (0 = north, +pi/2 = east)
export function headingVec(g, h) {
  const { east, north } = tangentFrame(g);
  return vnorm(vadd(vscale(north, Math.cos(h)), vscale(east, Math.sin(h))));
}
// compass heading of tangent vector v at g
export function headingOf(g, v) {
  const { east, north } = tangentFrame(g);
  return Math.atan2(vdot(v, east), vdot(v, north));
}
// walk `ang` radians along the great circle leaving g with heading h; returns the new point and the carried heading
export function moveAlong(g, h, ang) {
  if (Math.abs(ang) < 1e-12) return { g: g.slice(), h };
  const fwd = headingVec(g, h);
  const axis = vnorm(vcross(g, fwd));
  const ng = vnorm(rotAxis(g, axis, ang));
  const nf = rotAxis(fwd, axis, ang);
  return { g: ng, h: headingOf(ng, nf) };
}
// move g by a tangent offset (metres east, metres north) on a sphere of radius R
export function offsetDir(g, east, north, R) {
  const f = tangentFrame(g);
  return vnorm(vadd(g, vadd(vscale(f.east, east / R), vscale(f.north, north / R))));
}
