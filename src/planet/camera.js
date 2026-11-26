// Camera rig: one continuous camera from orbit down to standing on a beach.
// OWNER: camera agent.
//
// The camera is described by a point on the ground (unit direction `g` from the planet centre),
// a height above that ground (`alt`, metres above max(terrain, sea level)), a compass heading and a pitch.
// Far away it looks at the planet; close to the ground it looks toward the horizon.
//
// API used by main.js:
//   new CameraRig({ canvas, heightAt(dx,dy,dz) -> metres, R })
//   rig.update(dt)                -> advances input, glides and flights
//   rig.pos [x,y,z], rig.r, rig.u, rig.f (orthonormal basis), rig.altitude (m above sea level), rig.groundDir
//   rig.diveTo([x,y,z])           fly down to that surface direction
//   rig.land()                    cinematic flight to a coastline
//   rig.toHash() / rig.setFromHash(str)
//   rig.busy                      true while a scripted flight is running
//   rig.onInteract                optional callback, called on any user input
import { vadd, vsub, vscale, vdot, vcross, vnorm, vlen, slerp, rotAxis } from './vec.js';

const ORBIT_ALT = 165000;
const MIN_CLEAR = 1.8;

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const deg = Math.PI / 180;

export class CameraRig {
  constructor({ canvas, heightAt, R }) {
    this.canvas = canvas;
    this.heightAt = heightAt;
    this.R = R;
    this.g = vnorm([0.35, 0.42, 0.84]);
    this.alt = ORBIT_ALT;
    this.heading = 0;          // radians, 0 = north
    this.lookPitch = -6 * deg; // pitch used near the ground
    this.lookYaw = 0;          // extra yaw offset near the ground (drag to look around)
    this.vel = [0, 0];         // ground-plane glide velocity (east, north) in angular units/s
    this.zoomVel = 0;
    this.flight = null;
    this.keys = new Set();
    this.onInteract = null;
    this.pos = [0, 0, 0]; this.r = [1, 0, 0]; this.u = [0, 1, 0]; this.f = [0, 0, -1];
    this.altitude = 0;
    this.groundH = 0;
    this._bind();
    this._solve();
  }

  get busy() { return !!this.flight; }
  get groundDir() { return this.g; }

  // ---------- frames ----------
  _frame(g) {
    // local east/north at g (north toward +Y)
    let east = vcross([0, 1, 0], g);
    if (vlen(east) < 1e-6) east = [1, 0, 0];
    east = vnorm(east);
    const north = vcross(g, east);
    return { east, north };
  }

  // how "orbital" the view is: 1 far away, 0 near the ground
  orbitness(alt = this.alt) { return smooth(Math.log(4000), Math.log(90000), Math.log(Math.max(alt, 1))); }

  _solve() {
    const g = this.g;
    const gh = this.heightAt(g[0], g[1], g[2]);
    this.groundH = gh;
    const base = Math.max(gh, 0);
    const rad = this.R + base + Math.max(this.alt, MIN_CLEAR);
    this.pos = vscale(g, rad);
    this.altitude = rad - this.R;
    const { east, north } = this._frame(g);
    const h = this.heading + this.lookYaw;
    const fwdT = vadd(vscale(north, Math.cos(h)), vscale(east, Math.sin(h)));
    const o = this.orbitness();
    // near ground: pitch = lookPitch; far: look at the planet centre (with a slight forward tilt so the limb shows)
    const horizonDip = -Math.acos(Math.min(1, this.R / rad));
    const pNear = this.lookPitch + horizonDip * 0.5;
    const pFar = -88 * deg;
    const pitch = pNear + (pFar - pNear) * o;
    let f = vnorm(vadd(vscale(fwdT, Math.cos(pitch)), vscale(g, Math.sin(pitch))));
    let r = vnorm(vcross(f, g));
    if (!isFinite(r[0])) r = east;
    const u = vcross(r, f);
    this.f = f; this.r = r; this.u = u;
  }

  // ---------- input ----------
  _bind() {
    const c = this.canvas;
    const ptrs = new Map();
    let downAt = null, moved = 0, lastPinch = 0;
    const touch = () => this.onInteract && this.onInteract();
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture?.(e.pointerId);
      ptrs.set(e.pointerId, [e.clientX, e.clientY]);
      if (ptrs.size === 1) { downAt = [e.clientX, e.clientY, performance.now()]; moved = 0; }
      if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; lastPinch = Math.hypot(a[0] - b[0], a[1] - b[1]); downAt = null; }
      touch();
    });
    const up = (e) => {
      const was = ptrs.get(e.pointerId);
      ptrs.delete(e.pointerId);
      if (was && downAt && ptrs.size === 0 && moved < 8 && performance.now() - downAt[2] < 450 && e.type === 'pointerup') {
        this._tap(e.clientX, e.clientY);
      }
      if (ptrs.size === 0) downAt = null;
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('pointermove', (e) => {
      const p = ptrs.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p[0], dy = e.clientY - p[1];
      ptrs.set(e.pointerId, [e.clientX, e.clientY]);
      if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (lastPinch > 0) this.zoom(Math.log(lastPinch / d) * 2.2);
        lastPinch = d;
        return;
      }
      moved += Math.abs(dx) + Math.abs(dy);
      if (moved < 8) return;
      this.flight = null;
      this._drag(dx, dy);
      touch();
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.flight = null;
      this.zoom(Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 120) / 120 * 0.35);
      touch();
    }, { passive: false });
    addEventListener('keydown', (e) => { if (!e.metaKey && !e.ctrlKey) { this.keys.add(e.key.toLowerCase()); if (/^(w|a|s|d|q|e|arrow)/.test(e.key.toLowerCase())) { this.flight = null; touch(); } } });
    addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    addEventListener('blur', () => this.keys.clear());
  }

  zoom(amount) {
    // amount > 0 zooms out
    this.flight = null;
    this.zoomVel += amount;
  }

  _drag(dx, dy) {
    const o = this.orbitness();
    const h = Math.min(innerHeight, innerWidth);
    if (o > 0.5) {
      // spin the planet under the camera: move the ground point opposite to the drag
      const ang = (this.altitude + 2000) / this.R * 0.9 / h;
      this._moveGround(-dx * ang, dy * ang);
    } else {
      this.lookYaw -= dx / h * 2.2;
      this.lookPitch = Math.max(-80 * deg, Math.min(40 * deg, this.lookPitch + dy / h * 2.0));
    }
  }

  _moveGround(east, north) {
    // move the ground point by small angles (radians) along local east/north (rotated by heading)
    const { east: E, north: N } = this._frame(this.g);
    const h = this.heading;
    const fwd = vadd(vscale(N, Math.cos(h)), vscale(E, Math.sin(h)));
    const right = vadd(vscale(N, -Math.sin(h)), vscale(E, Math.cos(h)));
    const axis = vnorm(vadd(vscale(right, -north), vscale(fwd, east)));
    const ang = Math.hypot(east, north);
    if (ang < 1e-12) return;
    const ng = vnorm(rotAxis(this.g, axis, ang));
    // keep heading continuous: carry forward vector along
    const nf = rotAxis(fwd, axis, ang);
    this.g = ng;
    const fr = this._frame(ng);
    this.heading = Math.atan2(vdot(nf, fr.east), vdot(nf, fr.north));
  }

  _tap(x, y) {
    // dive to the tapped point on the planet
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const u = (2 * x - w) / h, v = -(2 * y - h) / h;
    const rd = vnorm(vadd(vadd(vscale(this.r, u), vscale(this.u, v)), vscale(this.f, this.focal || 2.5)));
    const ro = this.pos;
    const b = vdot(ro, rd), c = vdot(ro, ro) - this.R * this.R;
    const disc = b * b - c;
    if (disc < 0) return;
    const t = -b - Math.sqrt(disc);
    if (t < 0) return;
    const p = vadd(ro, vscale(rd, t));
    if (this.orbitness() > 0.15) this.diveTo(vnorm(p));
  }

  // ---------- scripted flights ----------
  diveTo(dir, { alt = 900, duration = 7 } = {}) {
    this.flight = {
      t: 0, duration,
      g0: this.g.slice(), g1: vnorm(dir),
      a0: this.alt, a1: alt,
      h0: this.heading, h1: this.heading,
      p0: this.lookPitch, p1: -6 * deg,
      y0: this.lookYaw, y1: 0,
    };
    this.zoomVel = 0; this.vel = [0, 0];
  }

  // find a coastline: land at the given dir, open sea a few km in front
  findCoast(near = this.g, tries = 4000) {
    let best = null;
    for (let i = 0; i < tries; i++) {
      const s = Math.min(1, 0.05 + i / tries * 1.5);
      const d = vnorm(vadd(near, [(Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s]));
      if (Math.abs(d[1]) > 0.7) continue;
      const h = this.heightAt(...d);
      if (h < 1.5 || h > 14) continue;
      const { east, north } = this._frame(d);
      for (let k = 0; k < 8; k++) {
        const a = k / 8 * Math.PI * 2;
        const fw = vadd(vscale(north, Math.cos(a)), vscale(east, Math.sin(a)));
        const sea = vnorm(vadd(d, vscale(fw, 2500 / this.R)));
        const back = vnorm(vadd(d, vscale(fw, -2500 / this.R)));
        if (this.heightAt(...sea) < -15 && this.heightAt(...back) > 40) {
          const score = this.heightAt(...back);
          if (!best || score > best.score) best = { dir: d, heading: a + Math.PI, score };
        }
      }
      if (best && i > 300) break;
    }
    return best;
  }

  land() {
    const c = this.findCoast();
    if (!c) return false;
    // face the mountains from out at sea, then settle on the beach looking inland
    this.flight = {
      t: 0, duration: 14,
      g0: this.g.slice(), g1: c.dir,
      a0: this.alt, a1: MIN_CLEAR + 0.2,
      h0: this.heading, h1: c.heading,
      p0: this.lookPitch, p1: 2 * deg,
      y0: this.lookYaw, y1: 0,
    };
    this.zoomVel = 0; this.vel = [0, 0];
    return true;
  }

  _stepFlight(dt) {
    const F = this.flight;
    F.t = Math.min(F.duration, F.t + dt);
    const x = F.t / F.duration;
    // position moves fast early, altitude falls exponentially, slowing at the end
    const sx = 1 - Math.pow(1 - x, 3);
    const ease = x * x * (3 - 2 * x);
    this.g = vnorm(slerp(F.g0, F.g1, Math.min(1, sx * 1.15)));
    const la0 = Math.log(Math.max(F.a0, 1)), la1 = Math.log(Math.max(F.a1, 1));
    this.alt = Math.exp(la0 + (la1 - la0) * ease);
    let dh = F.h1 - F.h0; dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    this.heading = F.h0 + dh * ease;
    this.lookPitch = F.p0 + (F.p1 - F.p0) * ease;
    this.lookYaw = F.y0 + (F.y1 - F.y0) * ease;
    if (F.t >= F.duration) this.flight = null;
  }

  update(dt) {
    dt = Math.min(dt, 0.1);
    if (this.flight) this._stepFlight(dt);
    // keyboard flight
    const k = this.keys;
    const fwd = (k.has('w') || k.has('arrowup') ? 1 : 0) - (k.has('s') || k.has('arrowdown') ? 1 : 0);
    const side = (k.has('d') || k.has('arrowright') ? 1 : 0) - (k.has('a') || k.has('arrowleft') ? 1 : 0);
    const vert = (k.has('e') || k.has(' ') ? 1 : 0) - (k.has('q') || k.has('c') ? 1 : 0);
    if (fwd || side) {
      const speed = (40 + this.alt * 0.9) / this.R; // rad/s
      const h = this.lookYaw;
      this.heading += h; this.lookYaw = 0;
      this._moveGround(side * speed * dt, fwd * speed * dt);
    }
    if (vert) this.zoomVel += vert * dt * 1.2;
    if (this.zoomVel) {
      const step = this.zoomVel * Math.min(1, dt * 6);
      this.alt = Math.min(ORBIT_ALT * 1.4, Math.max(MIN_CLEAR, this.alt * Math.exp(step)));
      this.zoomVel -= step;
      if (Math.abs(this.zoomVel) < 1e-4) this.zoomVel = 0;
    }
    this._solve();
  }

  toHash() {
    const g = this.g;
    const lat = Math.asin(g[1]) / deg, lon = Math.atan2(g[0], g[2]) / deg;
    return `cam=${lat.toFixed(4)},${lon.toFixed(4)},${Math.round(this.alt)},${(this.heading / deg).toFixed(1)},${(this.lookPitch / deg).toFixed(1)}`;
  }

  setFromHash(s) {
    const v = String(s).split(',').map(Number);
    if (v.length < 3 || v.slice(0, 3).some((x) => !isFinite(x))) return false;
    const [lat, lon, alt, hd = 0, pt = -6] = v;
    const cl = Math.cos(lat * deg);
    this.g = vnorm([cl * Math.sin(lon * deg), Math.sin(lat * deg), cl * Math.cos(lon * deg)]);
    this.alt = Math.max(MIN_CLEAR, alt);
    this.heading = (isFinite(hd) ? hd : 0) * deg;
    this.lookPitch = (isFinite(pt) ? pt : -6) * deg;
    this.lookYaw = 0;
    this.flight = null;
    this._solve();
    return true;
  }
}
