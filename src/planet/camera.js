// Camera rig: one continuous camera from orbit down to standing on a beach.
// OWNER: camera agent.
//
// The camera is described by a point on the ground (unit direction `g` from the planet centre), a height above the
// (smoothed) ground `alt`, a compass heading, a look pitch and a look yaw. Far away it looks at the planet (with an
// off-centre, sun-aware composition); close to the ground it looks toward the horizon. Everything that moves the
// camera (flights, drags, keys, inertia) changes those few numbers, so motion is always continuous.
//
// API used by main.js:
//   new CameraRig({ canvas, heightAt(dx,dy,dz) -> metres, R, sunDir() -> [x,y,z] })
//   rig.update(dt)                -> advances input, glides and flights
//   rig.pos [x,y,z], rig.r, rig.u, rig.f (orthonormal basis), rig.altitude (m above sea level), rig.groundDir
//   rig.orbitness()               1 in space, 0 near the ground
//   rig.focal                     written by main.js each frame (1 / tan(fovY/2)); used for tap rays
//   rig.diveTo([x,y,z])           fly down to that surface direction
//   rig.land()                    cinematic flight to a sunlit coastline, ending on the beach
//   rig.toHash() / rig.setFromHash(str)
//   rig.busy                      true while a scripted flight is running
//   rig.onInteract                optional callback, called on any user input
// Additions:
//   rig.orbitAlt                  altitude (m) of the opening orbit framing for the current aspect
//   rig.pick(clientX, clientY)    -> unit surface dir under that point, or null (empty space)
//   rig.toOrbit()                 fly back up to the opening composition (also: double-tap, 'O', Escape)
//   rig.findCoast()               -> { dir, heading, seaDir, sunElev, score } | null   (~5-40 ms)
//   rig.cancelFlight()            stop a scripted flight, keeping its momentum as glide
//   rig.flightKind                'dive' | 'land' | 'orbit' | null
//   rig.flightProgress            0..1 while busy
//   rig.groundH                   terrain height (m, can be < 0 under the sea) below the camera
import {
  vadd, vsub, vscale, vdot, vcross, vnorm, vlen, rotAxis, vangle, clamp, lerp, smoothstep, wrapPi, easeTail,
  tangentFrame, headingVec, headingOf, moveAlong, offsetDir,
} from './vec.js';

const deg = Math.PI / 180;
const EYE = 1.8;                         // standing eye height (m)
const FOCAL_ORBIT = 1 / Math.tan(24 * deg); // main.js fovFar = 48 deg
// opening composition
const PHASE = 98 * deg;                  // sun - planet - camera angle: >90 shows a crescent with a terminator
const CAM_LAT = 22 * deg;                // camera sits a little off the equator
const SUN_SCREEN = 14 * deg;             // light arrives from the left, slightly from above
const RIM_H = 9000;                      // visible thickness of the atmosphere glow at the limb (m)
const DIVE_ALT = 380;                    // where a dive settles (m above ground)
const DIVE_CRUISE = 26;                  // forward glide speed after a dive (m/s)
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const FLY_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown']);

export class CameraRig {
  constructor({ canvas, heightAt, R, sunDir = () => [1, 0, 0] }) {
    this.sunDir = sunDir;
    this.canvas = canvas;
    this.heightAt = heightAt;
    this.R = R;
    this.still = typeof location !== 'undefined' && /(^|[#&])still(=|&|$)/.test(location.hash || '');
    this.time = 0;
    this.heading = 0;           // radians, 0 = north
    this.lookPitch = -4 * deg;  // pitch used near the ground
    this.lookYaw = 0;           // extra yaw offset near the ground (drag to look around)
    this.vel = [0, 0];          // ground glide (right, forward) in rad/s
    this.cruise = 0;            // slow forward glide (m/s) after a dive
    this.zoomVel = 0;           // pending log-altitude change, consumed smoothly
    this.yawVel = 0; this.pitchVel = 0;
    this.flight = null;
    this.keys = new Set();
    this.onInteract = null;
    this.focal = undefined;
    this.pos = [0, 0, 0]; this.r = [1, 0, 0]; this.u = [0, 1, 0]; this.f = [0, 0, -1];
    this.altitude = 0;
    this.groundH = 0;
    this.idleAmp = 0;
    this._lastInput = -1e9;
    this._base = null;
    this._lastSunAz = null;
    this._rates = { g: [0, 0, 0], la: 0, h: 0, p: 0 };
    this._prev = null;
    this._speed = 0; this._moveDir = null;
    this._dragging = false;
    this._aspect = this._getAspect();
    const pose = this._orbitPose();
    this.g = pose.g; this.heading = pose.heading; this.alt = pose.alt;
    if (canvas && canvas.addEventListener) this._bind();
    this._solve(0, true);
  }

  get busy() { return !!this.flight; }
  get groundDir() { return this.g; }
  get flightKind() { return this.flight ? this.flight.kind : null; }
  get orbitAlt() { return this._fitAlt(); }
  get flightProgress() { return this.flight ? clamp(this.flight.t / this.flight.T, 0, 1) : 0; }

  _H(d) { return this.heightAt(d[0], d[1], d[2]); }

  // how "orbital" the view is: 1 far away, 0 near the ground
  orbitness(alt = this.alt) { return smoothstep(Math.log(4000), Math.log(90000), Math.log(Math.max(alt, 1))); }

  // ---------- composition ----------
  _getAspect() {
    const c = this.canvas || {};
    const w = c.clientWidth || (typeof innerWidth !== 'undefined' ? innerWidth : 16) || 16;
    const h = c.clientHeight || (typeof innerHeight !== 'undefined' ? innerHeight : 9) || 9;
    return w / h;
  }
  // where the planet sits in the opening frame (uv units: y in [-1, 1], x in [-aspect, aspect]) and how big it is.
  // rim = radius of planet + visible atmosphere glow; it fits in 85% of the narrower screen dimension (portrait:
  // whole planet with dark space around it, roughly centred; landscape: large and pushed right).
  _framing(aspect = this._aspect) {
    const rim = Math.min(0.72, 0.85 * Math.min(aspect, 1));
    const cx = clamp((aspect - 1.05) * 0.5, 0, 0.36);
    const cy = aspect < 1 ? -0.03 : 0.0;
    return { rim, cx, cy };
  }
  _fitAlt(aspect = this._aspect) {
    const { rim } = this._framing(aspect);
    const ang = Math.atan(rim / FOCAL_ORBIT);
    return (this.R + RIM_H) / Math.sin(ang) - this.R;
  }
  // camera ground point + heading for the opening shot, relative to the current sun
  _orbitPose() {
    const R = this.R;
    const s = vnorm(this.sunDir());
    const latS = Math.asin(clamp(s[1], -1, 1)), lonS = Math.atan2(s[0], s[2]);
    let best = null;
    for (const side of [1, -1]) {
      for (const ls of [1, -1]) {
        const latC = ls * CAM_LAT;
        const cosD = clamp((Math.cos(PHASE) - Math.sin(latC) * Math.sin(latS)) / (Math.cos(latC) * Math.cos(latS)), -1, 1);
        const lonC = lonS + side * Math.acos(cosD);
        const c = [Math.cos(latC) * Math.sin(lonC), Math.sin(latC), Math.cos(latC) * Math.cos(lonC)];
        // screen basis: right points away from the sun, then rolled so the light comes from slightly above
        const sp = vnorm(vsub(s, vscale(c, vdot(s, c))));
        const f = vscale(c, -1);
        const r0 = vscale(sp, -1), u0 = vcross(r0, f);
        const u = vsub(vscale(u0, Math.cos(SUN_SCREEN)), vscale(r0, Math.sin(SUN_SCREEN)));
        const heading = headingOf(c, u);
        // how good does the lit side look: some land, some sea, not all ice
        let land = 0, lit = 0;
        const fr = tangentFrame(c);
        for (let ring = 1; ring <= 4; ring++) {
          for (let k = 0; k < 10; k++) {
            const a = (k + ring * 0.37) / 10 * Math.PI * 2, rr = ring * 0.26;
            const p = vnorm(vadd(c, vadd(vscale(fr.east, Math.cos(a) * Math.tan(rr)), vscale(fr.north, Math.sin(a) * Math.tan(rr)))));
            if (vdot(p, s) < 0.08) continue;
            lit++;
            if (this._H(p) > 0) land++;
          }
        }
        const frac = lit ? land / lit : 0;
        const score = -Math.abs(frac - 0.42) - 0.2 * (ls < 0 ? 1 : 0);
        if (!best || score > best.score) best = { g: c, heading, score };
      }
    }
    void R;
    return { g: best.g, heading: best.heading, alt: this._fitAlt() };
  }

  // ---------- view ----------
  _pitch(alt, lookPitch) {
    const rad = this.R + Math.max(alt, EYE);
    const dip = Math.acos(Math.min(1, this.R / rad));
    const pNear = lookPitch - dip * 0.5;
    return pNear + (-88 * deg - pNear) * this.orbitness(alt);
  }
  // angular distance from the camera's ground point to (roughly) where the screen centre meets the ground.
  // A smooth flat-ground model on purpose: the exact ray hit races off to infinity near the horizon.
  _lookDist(alt, lookPitch) {
    const P = this._pitch(alt, lookPitch);
    const dep = clamp(-P + 4 * deg, 4 * deg, 90 * deg);
    return Math.max(alt, EYE) / Math.tan(dep) / this.R;
  }

  _solve(dt, snap = false) {
    const R = this.R, g = this.g;
    const gh = this._H(g);
    this.groundH = gh;
    const exact = Math.max(gh, 0);
    // smoothed ground with look-ahead, so flying over rough terrain is a glide, not a bounce, and rises in time
    let target = exact;
    const wS = smoothstep(6, 80, this.alt);
    if (wS > 0 && !snap) {
      if (this._moveDir && this._speed > 2) {
        for (const tt of [0.5, 1.2, 2.5, 4]) {
          const dist = Math.min(this._speed * tt, 6000);
          if (dist < 30) continue;
          const p = vnorm(vadd(g, vscale(this._moveDir, dist / R)));
          target = Math.max(target, this._H(p) - this.alt * 0.35);
        }
      }
      const fv = headingVec(g, this.heading + this.lookYaw);
      for (const dist of [this.alt * 0.5 + 20, this.alt * 1.5 + 60]) {
        const p = vnorm(vadd(g, vscale(fv, dist / R)));
        target = Math.max(target, this._H(p) - this.alt * 0.5);
      }
    }
    if (snap || this._base === null) this._base = target;
    else {
      const k = target > this._base ? 2.5 : 0.6;
      this._base += (target - this._base) * (1 - Math.exp(-dt * k));
    }
    const base = lerp(exact, this._base, wS);
    const floor = exact + Math.min(this.alt, Math.max(EYE, this.alt * 0.3));
    const h = Math.max(base + Math.max(this.alt, EYE), floor);
    const rad = R + h;
    this.pos = vscale(g, rad);
    this.altitude = h;

    const o = this.orbitness();
    const fwdT = headingVec(g, this.heading + this.lookYaw);
    const P = this._pitch(this.alt, this.lookPitch);
    let f = vnorm(vadd(vscale(fwdT, Math.cos(P)), vscale(g, Math.sin(P))));
    let r = vnorm(vcross(f, g));
    if (!isFinite(r[0])) r = tangentFrame(g).east;
    let u = vcross(r, f);
    // off-centre opening composition (fades out as we descend), plus a slow breathing drift when idle at orbit
    const fr = this._framing();
    const w = o * o;
    let kx = fr.cx / FOCAL_ORBIT * w, ky = fr.cy / FOCAL_ORBIT * w;
    if (this.idleAmp > 1e-4) {
      kx += this.idleAmp * 0.006 * Math.sin(this.time * 0.11);
      ky += this.idleAmp * 0.004 * Math.sin(this.time * 0.077 + 1.3);
    }
    if (kx || ky) {
      f = vnorm(vsub(vsub(f, vscale(r, kx)), vscale(u, ky)));
      r = vnorm(vcross(f, u));
      u = vcross(r, f);
    }
    this.f = f; this.r = r; this.u = u;
  }

  // ---------- input ----------
  _bind() {
    const c = this.canvas;
    const ptrs = new Map();
    let downAt = null, moved = 0, lastPinch = 0, multi = false, lastTap = null;
    let dragV = [0, 0], lastMoveT = 0;
    const touch = () => { this._lastInput = this.time; this.onInteract && this.onInteract(); };
    c.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      try { c.setPointerCapture?.(e.pointerId); } catch (_) { /* ignore */ }
      ptrs.set(e.pointerId, [e.clientX, e.clientY]);
      if (ptrs.size === 1) {
        downAt = [e.clientX, e.clientY, now()]; moved = 0; multi = false; dragV = [0, 0]; lastMoveT = now();
        // catch the spinning planet / stop looking around
        this.vel = [0, 0]; this.yawVel = 0; this.pitchVel = 0;
      }
      if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        lastPinch = Math.hypot(a[0] - b[0], a[1] - b[1]);
        multi = true;
        this._dragging = false;
      }
      touch();
    });
    const up = (e) => {
      const was = ptrs.get(e.pointerId);
      if (!was) return;
      ptrs.delete(e.pointerId);
      if (ptrs.size === 0) {
        const isTap = downAt && !multi && moved < 10 && now() - downAt[2] < 450 && e.type === 'pointerup';
        if (isTap) {
          const t = now();
          if (lastTap && t - lastTap[2] < 380 && Math.hypot(e.clientX - lastTap[0], e.clientY - lastTap[1]) < 40) {
            lastTap = null;
            this._doubleTap();
          } else {
            lastTap = [e.clientX, e.clientY, t];
            this._tap(e.clientX, e.clientY);
          }
        } else if (this._dragging && now() - lastMoveT < 90) {
          // release with momentum
          this._fling(dragV[0], dragV[1]);
        }
        this._dragging = false;
        downAt = null;
      } else if (ptrs.size === 1) {
        // one finger left after a pinch: keep it from becoming a jumpy drag
        lastPinch = 0;
      }
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('lostpointercapture', up);
    c.addEventListener('pointermove', (e) => {
      const p = ptrs.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p[0], dy = e.clientY - p[1];
      ptrs.set(e.pointerId, [e.clientX, e.clientY]);
      if (ptrs.size >= 2) {
        const [a, b] = [...ptrs.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (lastPinch > 0 && d > 0) { this.cancelFlight(); this.zoom(Math.log(lastPinch / d) * 2.0); }
        lastPinch = d;
        touch();
        return;
      }
      if (multi) return;
      moved += Math.abs(dx) + Math.abs(dy);
      if (moved < 10 && !this._dragging) return;
      if (!this._dragging) { this._dragging = true; this._dragMode = this.orbitness() > 0.5 ? 'spin' : 'look'; this.cancelFlight(); }
      const t = now(), el = Math.max(1, t - lastMoveT);
      lastMoveT = t;
      const a = Math.min(1, el / 60);
      dragV = [lerp(dragV[0], dx / el * 1000, a), lerp(dragV[1], dy / el * 1000, a)];
      this._drag(dx, dy);
      touch();
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      let dy = e.deltaY, dx = e.deltaX;
      if (e.deltaMode === 1) { dy *= 33; dx *= 33; } else if (e.deltaMode === 2) { dy *= 400; dx *= 400; }
      this.cancelFlight();
      if (e.ctrlKey) this.zoom(clamp(dy * 0.012, -0.5, 0.5));            // trackpad pinch
      else if (Math.abs(dx) > Math.abs(dy) * 1.5) { this._dragMode = this.orbitness() > 0.5 ? 'spin' : 'look'; this._drag(-dx * 0.6, 0); }
      else this.zoom(clamp(dy * 0.0022, -0.45, 0.45));
      touch();
    }, { passive: false });
    // Safari (macOS trackpad pinch, iOS page zoom)
    let gScale = 1;
    const gs = (e) => { e.preventDefault(); gScale = 1; };
    c.addEventListener('gesturestart', gs);
    c.addEventListener('gesturechange', (e) => {
      e.preventDefault();
      if (ptrs.size >= 2) return; // touch pinch already handled through pointers
      const s = e.scale || 1;
      this.cancelFlight();
      this.zoom(-Math.log(s / gScale) * 2.0);
      gScale = s;
      touch();
    });
    c.addEventListener('gestureend', (e) => e.preventDefault());
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('gesturestart', (e) => e.preventDefault());
    }
    if (typeof addEventListener !== 'undefined') {
      addEventListener('keydown', (e) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        const t = e.target;
        if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''))) return;
        const code = e.code || e.key;
        if (code === 'ShiftLeft' || code === 'ShiftRight') { this.keys.add('Shift'); return; }
        if (code === 'Escape' || code === 'KeyO') { if (!e.repeat) { this.toOrbit(); touch(); } return; }
        if (FLY_KEYS.has(code)) {
          this.keys.add(code);
          this.cancelFlight();
          touch();
          if (/^(Arrow|Page)/.test(code)) e.preventDefault();
        }
      });
      addEventListener('keyup', (e) => {
        const code = e.code || e.key;
        if (code === 'ShiftLeft' || code === 'ShiftRight') this.keys.delete('Shift');
        else this.keys.delete(code);
      });
      addEventListener('blur', () => this.keys.clear());
    }
  }

  zoom(amount) {
    // amount > 0 zooms out (log-altitude units)
    this.cancelFlight();
    this.zoomVel += amount;
  }

  _vh() { return Math.max(1, Math.min(this.canvas?.clientHeight || 0, this.canvas?.clientWidth || 0) || (typeof innerHeight !== 'undefined' ? Math.min(innerHeight, innerWidth) : 800)); }
  _spinRate() {
    // radians of planet rotation per pixel so the ground under the finger follows it
    const h = this.canvas?.clientHeight || (typeof innerHeight !== 'undefined' ? innerHeight : 800) || 800;
    const focal = this.focal || FOCAL_ORBIT;
    return Math.max(this.alt, 300) / (this.R * focal * 0.5 * h);
  }
  _drag(dx, dy) {
    if ((this._dragMode || (this.orbitness() > 0.5 ? 'spin' : 'look')) === 'spin') {
      const ang = this._spinRate();
      this._moveGround(-dx * ang, dy * ang);
    } else {
      const h = this._vh();
      this.lookYaw -= dx / h * 2.0;
      this.lookPitch = clamp(this.lookPitch + dy / h * 1.8, -80 * deg, 45 * deg);
    }
  }
  _fling(vx, vy) {
    const sp = Math.hypot(vx, vy);
    if (sp < 30) return;
    const k = Math.min(1, 2500 / sp);
    vx *= k; vy *= k;
    if (this._dragMode === 'spin') {
      const ang = this._spinRate();
      let v = [-vx * ang, vy * ang];
      const m = Math.hypot(v[0], v[1]), cap = 1.2; // rad/s
      if (m > cap) v = [v[0] * cap / m, v[1] * cap / m];
      this.vel = v;
    } else {
      const h = this._vh();
      this.yawVel = clamp(-vx / h * 1.0, -1.5, 1.5);
      this.pitchVel = clamp(vy / h * 0.6, -0.8, 0.8);
    }
  }

  _moveGround(right, fwd) {
    // move the ground point by small angles (radians) along the heading frame, carrying the heading with it
    const ang = Math.hypot(right, fwd);
    if (ang < 1e-12) return;
    const h = this.heading + Math.atan2(right, fwd);
    const m = moveAlong(this.g, h, ang);
    this.heading = wrapPi(m.h - Math.atan2(right, fwd));
    this.g = m.g;
  }

  // surface direction under a client-space point, or null for empty space (taps on the glow snap to the limb)
  pick(x, y) {
    const c = this.canvas;
    const w = c.clientWidth || innerWidth, h = c.clientHeight || innerHeight;
    const rect = c.getBoundingClientRect ? c.getBoundingClientRect() : { left: 0, top: 0 };
    x -= rect.left || 0; y -= rect.top || 0;
    const u = (2 * x - w) / h, v = -(2 * y - h) / h;
    const rd = vnorm(vadd(vadd(vscale(this.r, u), vscale(this.u, v)), vscale(this.f, this.focal || FOCAL_ORBIT)));
    const ro = this.pos;
    const b = vdot(ro, rd), cc = vdot(ro, ro) - this.R * this.R;
    const disc = b * b - cc;
    if (disc >= 0) {
      const t = -b - Math.sqrt(disc);
      return t < 0 ? null : vnorm(vadd(ro, vscale(rd, t)));
    }
    const ca = vadd(ro, vscale(rd, -b)); // closest approach to the centre
    if (-b < 0 || vlen(ca) > this.R * 1.18) return null;
    return vnorm(ca);
  }
  // dive to the tapped point on the planet; returns true if a dive started
  _tap(x, y) {
    if (this.orbitness() < 0.12) return false;
    const p = this.pick(x, y);
    if (!p) return false;
    this.diveTo(p);
    return true;
  }
  _doubleTap() {
    if (this.orbitness() < 0.85) this.toOrbit();
  }

  // ---------- scripted flights ----------
  cancelFlight() {
    const F = this.flight;
    if (!F) return;
    this.flight = null;
    // keep the momentum: hand the flight's current velocities to the free glide
    const r = this._rates, g = this.g;
    const fwd = headingVec(g, this.heading), right = headingVec(g, this.heading + Math.PI / 2);
    const vf = vdot(r.g, fwd), vr = vdot(r.g, right);
    const fm = vf * this.R;
    if (this.orbitness() < 0.3 && fm > 0) { this.cruise = Math.min(fm, 250); this.vel = [vr, 0]; }
    else { this.cruise = 0; this.vel = [vr, vf]; }
    this.zoomVel = clamp(r.la / 6, -1, 1);
    this.yawVel = clamp(r.h, -2, 2);
    this.pitchVel = clamp(r.p, -1, 1);
    this.heading += this.lookYaw; this.lookYaw = 0;
  }

  _startFlight(kind, segs, vEnd = 0) {
    const T = segs.reduce((a, s) => a + s.T, 0);
    this.flight = {
      kind, segs, T, t: 0, vEnd,
      s0: { g: this.g.slice(), la: Math.log(Math.max(this.alt, EYE)), h: this.heading + this.lookYaw, p: this.lookPitch },
      r0: { g: this._rates.g.slice(), la: this._rates.la, h: this._rates.h, p: this._rates.p },
      blendT: 0.9,
    };
    this.heading += this.lookYaw; this.lookYaw = 0;
    this.vel = [0, 0]; this.zoomVel = 0; this.cruise = 0; this.yawVel = 0; this.pitchVel = 0;
  }

  // One continuous move from the current state to "looking at `aim` from `alt1` with heading `heading1`".
  // The camera always looks at a point that slides from where it looks now to `aim`; sideways travel is spent
  // in proportion to altitude (constant apparent speed); altitude follows an eased log curve (with a hop for long
  // low flights); the view tilts from straight down to the horizon via orbitness() as altitude drops.
  _planFly({ from, aim, alt1, heading1, pitch1, vEnd = 0, rampFrac = 0.3, n = 2.4, extraTilt = 0, qa = 0.06, qb = 0.8, duration }) {
    const R = this.R;
    const g0 = from ? from.g : this.g.slice();
    const a0 = Math.max(from ? from.alt : this.alt, EYE);
    const h0 = from ? from.heading : this.heading + this.lookYaw;
    const p0 = from ? from.pitch : this.lookPitch;
    const A0 = moveAlong(g0, h0, this._lookDist(a0, p0));
    const aim0 = A0.g;
    const T1 = vnorm(aim);
    const ang = vangle(aim0, T1);
    let axis = vcross(aim0, T1);
    axis = vlen(axis) > 1e-9 ? vnorm(axis) : vnorm(vcross(aim0, headingVec(aim0, A0.h)));
    const fwd0 = headingVec(aim0, A0.h);
    const hNat = headingOf(T1, rotAxis(fwd0, axis, ang));
    const dh = wrapPi(heading1 - hNat);
    const D = ang * R;
    alt1 = Math.max(alt1, EYE);
    const la0 = Math.log(a0), la1 = Math.log(alt1);
    const peak = Math.max(0, D * 0.3 - Math.max(a0, alt1));
    const T = duration ?? clamp(3.4 + 0.85 * Math.abs(la1 - la0) + 1.6 * Math.min(1, D / R) + 0.5 * Math.log1p(peak / 1000) + Math.abs(dh) * 0.5, 3.5, 12.5);
    const altAt = (tau) => Math.exp(la0 + (la1 - la0) * easeTail(tau, n)) + peak * Math.sin(Math.PI * tau) ** 2;
    // lateral progress table: d(progress) ~ altitude; cruise distance table
    const N = 160, P = new Float64Array(N + 1), C = new Float64Array(N + 1);
    const wmin = 0.05 * Math.min(a0, alt1);
    let prevW = 0, prevR = 0;
    for (let i = 1; i <= N; i++) {
      const tau = i / N;
      const wgt = (altAt(tau) + wmin) * Math.pow(Math.sin(Math.PI * tau), 0.7);
      const rr = smoothstep(1 - rampFrac, 1, tau);
      P[i] = P[i - 1] + (wgt + prevW) * 0.5 / N;
      C[i] = C[i - 1] + (rr + prevR) * 0.5 / N;
      prevW = wgt; prevR = rr;
    }
    const PN = P[N] || 1;
    const look = (tbl, tau) => { const x = clamp(tau, 0, 1) * N, i = Math.min(N - 1, Math.floor(x)), fr = x - i; return tbl[i] + (tbl[i + 1] - tbl[i]) * fr; };
    const tiltHi = Math.log(7000), tiltLo = Math.log(Math.max(alt1 * 2, 50));
    const self = this;
    return {
      T,
      eval(t) {
        const tau = clamp(t / T, 0, 1);
        const alt = altAt(tau);
        const p = look(P, tau) / PN;
        const q = smoothstep(qa, qb, tau);
        const aimT = rotAxis(aim0, axis, ang * p);
        const fwdT = rotAxis(fwd0, axis, ang * p);
        const hAim = headingOf(aimT, fwdT) + dh * q;
        const pitch = lerp(p0, pitch1, q) - extraTilt * smoothstep(tiltLo, tiltHi, Math.log(alt));
        const back = moveAlong(aimT, hAim, -self._lookDist(alt, pitch));
        const fin = moveAlong(back.g, back.h, vEnd * T * look(C, tau) / R);
        return { g: fin.g, alt, heading: fin.h, pitch };
      },
    };
  }

  // pick a heading for the end of a dive: coast / mountains ahead, side light, no wall, not too much turning
  _diveHeading(T, hNat, alt1) {
    const R = this.R, s = vnorm(this.sunDir());
    const e = Math.asin(clamp(vdot(s, T), -1, 1));
    const sT = vsub(s, vscale(T, vdot(s, T)));
    const hSun = vlen(sT) > 1e-6 ? headingOf(T, vnorm(sT)) : 0;
    const h0 = Math.max(this._H(T), 0);
    let best = hNat, bestS = -1e9;
    for (let k = 0; k < 16; k++) {
      const h = hNat + k / 16 * Math.PI * 2;
      let prevLand = null, trans = 0, maxH = -1e9, land = 0, sea = 0, wall = 0;
      for (const km of [0.6, 1.5, 3, 5, 8, 12, 18]) {
        const p = moveAlong(T, h, km * 1000 / R).g;
        const hh = this._H(p);
        const isLand = hh > 0;
        if (prevLand !== null && isLand !== prevLand) trans++;
        prevLand = isLand;
        if (isLand) land++; else sea++;
        maxH = Math.max(maxH, hh);
        if (km <= 1.5) wall = Math.max(wall, hh - h0);
      }
      const interest = 0.6 * Math.min(1, trans / 2) + 0.8 * clamp(maxH / 900, 0, 1) + (land && sea ? 0.3 : 0);
      const rel = Math.abs(wrapPi(hSun - h));
      const sun = e > -0.03 ? Math.exp(-(((rel - 55 * deg) / (45 * deg)) ** 2)) : 0;
      const turn = Math.abs(wrapPi(h - hNat)) / Math.PI;
      const S = interest + 0.6 * sun - 0.35 * turn - (wall > alt1 * 0.7 ? 1.5 : 0);
      if (S > bestS) { bestS = S; best = h; }
    }
    return best;
  }

  // a dive aimed at open ocean is moved toward the nearest coast (up to ~40 km) so the shot ends with land in view
  _nudgeToLand(T) {
    const R = this.R;
    if (this._H(T) > -40) return T;
    let best = null;
    for (let k = 0; k < 16 && !(best && best.km <= 8); k++) {
      const h = k / 16 * Math.PI * 2;
      for (const km of [4, 8, 12, 17, 23, 30, 40]) {
        if (best && km >= best.km) break;
        if (this._H(moveAlong(T, h, km * 1000 / R).g) > 40) { best = { h, km }; break; }
      }
    }
    if (!best || best.km <= 8) return T;
    return moveAlong(T, best.h, (best.km - 7) * 1000 / R).g;
  }

  diveTo(dir, { alt = DIVE_ALT, duration } = {}) {
    const T = this._nudgeToLand(vnorm(dir));
    // natural heading: the current one carried to the target
    const a0 = Math.max(this.alt, EYE);
    const A0 = moveAlong(this.g, this.heading + this.lookYaw, this._lookDist(a0, this.lookPitch));
    let axis = vcross(A0.g, T);
    const ang = vangle(A0.g, T);
    axis = vlen(axis) > 1e-9 ? vnorm(axis) : [0, 1, 0];
    const hNat = headingOf(T, rotAxis(headingVec(A0.g, A0.h), axis, ang));
    const heading1 = this._diveHeading(T, hNat, alt);
    const seg = this._planFly({ aim: T, alt1: alt, heading1, pitch1: -4 * deg, vEnd: DIVE_CRUISE, extraTilt: 12 * deg, duration });
    this._startFlight('dive', [seg], DIVE_CRUISE);
    return true;
  }

  toOrbit({ duration } = {}) {
    const pose = this._orbitPose();
    const aim = moveAlong(pose.g, pose.heading, this._lookDist(pose.alt, -6 * deg));
    const seg = this._planFly({ aim: aim.g, alt1: pose.alt, heading1: aim.h, pitch1: -6 * deg, n: 2, qa: 0.15, qb: 0.95, duration });
    this._startFlight('orbit', [seg], 0);
    return true;
  }

  // ---------- coast finder ----------
  // Looks for a beach in daylight with a low sun, open sea on one side and high ground behind. Samples along the
  // "golden hour" ring of the sun near the camera, walks each sample onto the shoreline with a few Newton steps on
  // the height field, then scores the view. Time-boxed (~40 ms worst case), deterministic for a given state.
  findCoast({ near = this.g, budgetMs = 40 } = {}) {
    const t0 = now();
    const R = this.R;
    const s = vnorm(this.sunDir());
    // ring basis around the sun axis, phase chosen nearest to `near`
    let c1 = vsub(near, vscale(s, vdot(near, s)));
    if (vlen(c1) < 1e-4) c1 = tangentFrame(s).east;
    c1 = vnorm(c1);
    const c2 = vcross(s, c1);
    let seed = 0x9e3779b9 ^ Math.floor((near[0] * 7919 + near[1] * 104729 + near[2] * 1299709) * 1000);
    const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    let best = null, tries = 0, found = 0;
    const H = (d) => this._H(d);
    const at = (d, w, dist, lat = 0) => offsetDir(d, w[0] * dist - w[1] * lat, w[1] * dist + w[0] * lat, R);
    while (true) {
      const el = now() - t0;
      if (el > budgetMs || (found >= 60 && el > budgetMs * 0.5) || tries > 6000) break;
      tries++;
      const pass = el < budgetMs * 0.55 ? 0 : (el < budgetMs * 0.8 ? 1 : 2);
      const spread = (pass === 0 ? 0.25 + 1.2 * Math.min(1, tries / 600) : Math.PI);
      const phi = (rnd() * 2 - 1) * spread;
      const eLo = pass === 2 ? -10 : (pass === 1 ? 2 : 5), eHi = pass === 2 ? 80 : (pass === 1 ? 50 : 36);
      const ee = (eLo + (eHi - eLo) * rnd()) * deg;
      let d = vnorm(vadd(vscale(s, Math.sin(ee)), vscale(vadd(vscale(c1, Math.cos(phi)), vscale(c2, Math.sin(phi))), Math.cos(ee))));
      if (Math.abs(d[1]) > 0.82) continue;
      let h = H(d);
      if (h < -160 || h > 260) continue;
      // walk onto the shoreline (target height ~2.5 m)
      const eps = 120;
      let hx = 0, hy = 0, ok = false;
      for (let it = 0; it < 7; it++) {
        hx = H(offsetDir(d, eps, 0, R)) - h; hy = H(offsetDir(d, 0, eps, R)) - h;
        const g2 = hx * hx + hy * hy;
        if (g2 < 1e-4) break;
        if (Math.abs(h - 2.5) < 1.4) { ok = true; break; }
        const k = (2.5 - h) / g2 * eps;
        let dx = hx * k, dy = hy * k;
        const m = Math.hypot(dx, dy);
        if (m > 1200) { dx *= 1200 / m; dy *= 1200 / m; }
        d = offsetDir(d, dx, dy, R);
        h = H(d);
      }
      if (!ok || h < 0.7 || h > 6) continue;
      const gl = Math.hypot(hx, hy);
      const w = [-hx / gl, -hy / gl];              // seaward, in (east, north) of d
      // open sea in front, a gentle beach, not a lake
      if (H(at(d, w, 250)) > -0.5) continue;
      if (H(at(d, w, 900)) > -5) continue;
      if (H(at(d, w, 2500)) > -12) continue;
      if (H(at(d, w, 1200, 900)) > 0 && H(at(d, w, 1200, -900)) > 0) continue;
      if (H(at(d, w, -70)) > 22) continue;
      // high ground behind
      let mount = 0;
      for (const [dist, lat] of [[1800, 0], [3500, 0], [6000, 0], [9000, 0], [4500, 3000], [4500, -3000]]) mount = Math.max(mount, H(at(d, w, -dist, lat)));
      const frame = tangentFrame(d);
      const e = Math.asin(clamp(vdot(s, d), -1, 1));
      const sTv = vsub(s, vscale(d, vdot(s, d)));
      const sT = vlen(sTv) > 1e-6 ? vnorm(sTv) : frame.north;
      const sunSea = vdot(sT, vadd(vscale(frame.east, w[0]), vscale(frame.north, w[1])));
      // two ways to look along the coast, turned 15 degrees toward the sea
      for (const side of [1, -1]) {
        const tx = -w[1] * side, ty = w[0] * side;
        const k25 = Math.tan(15 * deg);
        let vx = tx + w[0] * k25, vy = ty + w[1] * k25;
        const vl = Math.hypot(vx, vy); vx /= vl; vy /= vl;
        const v3 = vadd(vscale(frame.east, vx), vscale(frame.north, vy));
        const near1 = H(offsetDir(d, vx * 250, vy * 250, R)), near2 = H(offsetDir(d, vx * 800, vy * 800, R));
        if (near1 > 14 || near2 > 70) continue;
        // high ground actually in the view cone: ahead along the coast, inland
        let seen = 0;
        for (const [fa, ba] of [[3000, 1500], [5000, 2500], [8000, 3000]]) {
          seen = Math.max(seen, H(offsetDir(d, vx * fa - w[0] * ba, vy * fa - w[1] * ba, R)));
        }
        const rel = Math.abs(Math.acos(clamp(vdot(v3, sT), -1, 1)));
        const score = 0.6 * clamp((mount - 120) / 900, 0, 1) + 1.0 * clamp((seen - 80) / 700, 0, 1)
          + (pass === 2 ? 0 : 1.0 * Math.exp(-(((e - 18 * deg) / (12 * deg)) ** 2)))
          + 0.7 * Math.exp(-(((rel - 60 * deg) / (40 * deg)) ** 2))
          + 0.3 * Math.max(0, sunSea)
          - 0.25 * vangle(near, d)
          - (e < 0 ? 2 : 0);
        found++;
        if (!best || score > best.score) best = { dir: d, heading: headingOf(d, v3), seaDir: vadd(vscale(frame.east, w[0]), vscale(frame.north, w[1])), sunElev: e, score, height: h };
      }
    }
    if (best) { best.ms = now() - t0; best.tries = tries; }
    return best;
  }

  land() {
    const c = this.findCoast();
    if (!c) return false;
    const R = this.R;
    // A: dive to a point just offshore, facing the beach and the mountains behind it, arriving with speed
    // come in from the sea diagonally, already turned a little toward the final view
    const hInland = headingOf(c.dir, vscale(c.seaDir, -1));
    const hIn = hInland + wrapPi(c.heading - hInland) * 0.3;
    const vA = 200;
    const segA = this._planFly({ aim: c.dir, alt1: 140, heading1: hIn, pitch1: -3 * deg, vEnd: vA, rampFrac: 0.3, extraTilt: 10 * deg });
    const endA = segA.eval(segA.T);
    // B: skim in over the water, settle on the sand and turn to look along the coast
    const fr = tangentFrame(c.dir);
    const dd = vdot(endA.g, c.dir);
    const P0 = [vdot(endA.g, fr.east) / dd * R, vdot(endA.g, fr.north) / dd * R];
    const fA = headingVec(endA.g, endA.heading);
    const V0 = [vdot(fA, fr.east) * vA, vdot(fA, fr.north) * vA];
    const L = Math.hypot(P0[0], P0[1]);
    const TB = clamp(1.6 * L / vA, 4.5, 9);
    const hS = endA.heading, hF = c.heading, aS = endA.alt, pS = endA.pitch;
    const segB = {
      T: TB,
      eval(t) {
        const s = clamp(t / TB, 0, 1);
        const s2 = s * s, s3 = s2 * s;
        const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s;
        const x = P0[0] * h00 + V0[0] * TB * h10, y = P0[1] * h00 + V0[1] * TB * h10;
        const g = vnorm(vadd(c.dir, vadd(vscale(fr.east, x / R), vscale(fr.north, y / R))));
        const q = smoothstep(0.25, 1, s);
        const alt = EYE + (aS - EYE) * (1 - easeTail(s, 2.2));
        return { g, alt, heading: hS + wrapPi(hF - hS) * q, pitch: lerp(pS, 1 * deg, q) };
      },
    };
    this._startFlight('land', [segA, segB], 0);
    this.lastCoast = c;
    return true;
  }

  _stepFlight(dt) {
    const F = this.flight;
    F.t = Math.min(F.T, F.t + dt);
    let t = F.t, st = null;
    for (const s of F.segs) { if (t <= s.T || s === F.segs[F.segs.length - 1]) { st = s.eval(Math.min(t, s.T)); break; } t -= s.T; }
    if (F.t < F.blendT) {
      // blend in from the motion we had when the flight started, so it never starts with a jerk
      const w = smoothstep(0, F.blendT, F.t), tau = 0.5, dtx = tau * (1 - Math.exp(-F.t / tau));
      const ex = vnorm(vadd(F.s0.g, vscale(F.r0.g, dtx)));
      const eLa = F.s0.la + F.r0.la * dtx, eH = F.s0.h + F.r0.h * dtx, eP = F.s0.p + F.r0.p * dtx;
      const ang = vangle(ex, st.g);
      if (ang > 1e-9) {
        const m = vnorm(vcross(ex, st.g));
        st.g = vnorm(rotAxis(ex, m, ang * w));
      }
      st.alt = Math.exp(lerp(eLa, Math.log(st.alt), w));
      st.heading = eH + wrapPi(st.heading - eH) * w;
      st.pitch = lerp(eP, st.pitch, w);
    }
    this.g = st.g; this.alt = st.alt; this.heading = st.heading; this.lookPitch = st.pitch; this.lookYaw = 0;
    if (F.t >= F.T) {
      this.flight = null;
      this.cruise = F.vEnd;
      this.vel = [0, 0]; this.zoomVel = 0; this.yawVel = 0; this.pitchVel = 0;
    }
  }

  update(dt) {
    dt = Math.min(Math.max(dt || 0, 0), 0.1);
    this.time += dt;
    const o = this.orbitness();
    // phone rotated / window resized while sitting at orbit: refit the planet
    const asp = this._getAspect();
    if (Math.abs(asp / this._aspect - 1) > 0.02) {
      this._aspect = asp;
      if (!this.flight && o > 0.9) this.zoomVel = Math.log(this._fitAlt() / this.alt);
    }
    if (this.flight) this._stepFlight(dt);
    else this._free(dt, o);
    // the sun circles the pole: at orbit keep the composition (the planet turns beneath us instead)
    const s = this.sunDir();
    const az = Math.atan2(s[2], s[0]);
    if (this._lastSunAz !== null && !this.flight) {
      const d = wrapPi(az - this._lastSunAz);
      const w = smoothstep(0.55, 0.92, this.orbitness());
      if (d && w > 0) this.g = vnorm(rotAxis(this.g, [0, 1, 0], -d * w));
    }
    this._lastSunAz = az;
    // gentle breathing when idle at orbit
    const idle = !this.still && !this.flight && this.orbitness() > 0.95 && this.time - this._lastInput > 3;
    this.idleAmp += ((idle ? 1 : 0) - this.idleAmp) * (1 - Math.exp(-dt * 0.35));
    this._measure(dt);
    this._solve(dt);
  }

  _free(dt, o) {
    const k = this.keys;
    const kd = (c) => (k.has(c) ? 1 : 0);
    const fwd = kd('KeyW') + kd('ArrowUp') - kd('KeyS') - kd('ArrowDown');
    const arrowsSide = kd('ArrowRight') - kd('ArrowLeft');
    const side = kd('KeyD') - kd('KeyA') + (o >= 0.5 ? arrowsSide : 0);
    const turn = o < 0.5 ? arrowsSide : 0;
    const vert = kd('KeyE') + kd('PageUp') - kd('KeyQ') - kd('PageDown');
    const boost = k.has('Shift') ? 4 : 1;
    if (fwd || side) {
      if (this.lookYaw) { this.heading += this.lookYaw; this.lookYaw = 0; }
      const sp = Math.min(0.35, (5 + this.alt * 0.4) * boost / this.R);
      const n = Math.hypot(fwd, side) || 1;
      const a = 1 - Math.exp(-dt * 4);
      this.vel[0] += (side / n * sp - this.vel[0]) * a;
      this.vel[1] += (fwd / n * sp - this.vel[1]) * a;
      this.cruise *= Math.exp(-dt * 3);
    } else if (!this._dragging) {
      const dec = Math.exp(-dt * 2.2);
      this.vel[0] *= dec; this.vel[1] *= dec;
    }
    if (Math.abs(this.vel[0]) + Math.abs(this.vel[1]) > 1e-10) this._moveGround(this.vel[0] * dt, this.vel[1] * dt);
    if (this.cruise) {
      this._moveGround(0, this.cruise / this.R * dt);
      this.cruise *= Math.exp(-dt / 9);
      if (this.cruise < 0.3) this.cruise = 0;
    }
    if (turn) this.yawVel += (turn * 1.3 * (boost > 1 ? 1.6 : 1) - this.yawVel) * (1 - Math.exp(-dt * 6));
    if (!this._dragging) {
      if (this.yawVel || this.pitchVel) {
        if (turn) this.heading += this.yawVel * dt; else this.lookYaw += this.yawVel * dt;
        this.lookPitch = clamp(this.lookPitch + this.pitchVel * dt, -80 * deg, 45 * deg);
        const dec = Math.exp(-dt * (turn ? 0 : 5));
        this.yawVel *= dec; this.pitchVel *= Math.exp(-dt * 5);
        if (Math.abs(this.yawVel) < 1e-4) this.yawVel = 0;
        if (Math.abs(this.pitchVel) < 1e-4) this.pitchVel = 0;
      }
    }
    if (vert) this.zoomVel += vert * dt * 1.3 * (boost > 1 ? 2 : 1);
    if (this.zoomVel) {
      const step = this.zoomVel * Math.min(1, dt * 6);
      const maxAlt = this._fitAlt() * 1.8;
      const na = clamp(this.alt * Math.exp(step), EYE, maxAlt);
      this.zoomVel -= step;
      if (na === EYE || na === maxAlt) this.zoomVel = 0;
      this.alt = na;
      if (Math.abs(this.zoomVel) < 1e-4) this.zoomVel = 0;
    }
  }

  _measure(dt) {
    const cur = { g: this.g.slice(), la: Math.log(Math.max(this.alt, EYE)), h: this.heading + this.lookYaw, p: this.lookPitch };
    const p = this._prev;
    if (p && dt > 1e-4) {
      const a = 1 - Math.exp(-dt * 14), r = this._rates;
      const gr = vscale(vsub(cur.g, p.g), 1 / dt);
      r.g = vadd(r.g, vscale(vsub(gr, r.g), a));
      r.la += ((cur.la - p.la) / dt - r.la) * a;
      r.h += (wrapPi(cur.h - p.h) / dt - r.h) * a;
      r.p += ((cur.p - p.p) / dt - r.p) * a;
      const sp = vlen(r.g);
      this._speed = sp * this.R;
      this._moveDir = sp > 1e-9 ? vnorm(r.g) : null;
    }
    this._prev = cur;
  }

  _teleported() {
    this._prev = null;
    this._rates = { g: [0, 0, 0], la: 0, h: 0, p: 0 };
    this._speed = 0; this._moveDir = null;
    this.vel = [0, 0]; this.cruise = 0; this.zoomVel = 0; this.yawVel = 0; this.pitchVel = 0;
  }

  toHash() {
    const g = this.g;
    const lat = Math.asin(clamp(g[1], -1, 1)) / deg, lon = Math.atan2(g[0], g[2]) / deg;
    return `cam=${lat.toFixed(4)},${lon.toFixed(4)},${Math.round(this.alt * 10) / 10},${(wrapPi(this.heading + this.lookYaw) / deg).toFixed(1)},${(this.lookPitch / deg).toFixed(1)}`;
  }

  setFromHash(s) {
    const v = String(s).split(',').map(Number);
    if (v.length < 3 || v.slice(0, 3).some((x) => !isFinite(x))) return false;
    const [lat, lon, alt, hd = 0, pt = -4] = v;
    const cl = Math.cos(lat * deg);
    this.g = vnorm([cl * Math.sin(lon * deg), Math.sin(lat * deg), cl * Math.cos(lon * deg)]);
    this.alt = Math.max(EYE, alt);
    this.heading = (isFinite(hd) ? hd : 0) * deg;
    this.lookPitch = (isFinite(pt) ? pt : -4) * deg;
    this.lookYaw = 0;
    this.flight = null;
    this._teleported();
    this._solve(0, true);
    return true;
  }
}
