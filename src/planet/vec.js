// Tiny 3-vector helpers (arrays of 3 numbers).
export const vadd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const vscale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const vlen = (a) => Math.hypot(a[0], a[1], a[2]);
export const vnorm = (a) => { const l = vlen(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
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
