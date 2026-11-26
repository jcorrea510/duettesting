// Extras: things that make the planet feel alive at night and from space (aurora, moon, etc).
// OWNER: night-side agent.
//
// CONTRACT:
//   vec3 extrasEmission(vec3 ro, vec3 rd, float tHit)    additive light along the view ray in front of tHit (e.g. aurora curtains)
//   vec3 nightSurfaceGlow(vec3 p, vec3 n)                additive emission on the dark side of land (keep subtle; no cities: nobody lives here)
// May call anything declared earlier (atmosphere, clouds, terrain, ocean).
//
// What lives here (all of it fades out where the sun is up, and early-outs before doing any real work):
//   - aurora: green-to-magenta curtains in an oval around each pole, 3.8-12.5 km up, marched only over the part of
//     the ray that is inside the aurora shell AND inside the polar latitude slab (most rays: zero iterations)
//   - airglow: a thin green emission shell at 9.5 km; closed-form column density, no loop (the limb line from orbit,
//     a faint glow low on the horizon from the ground)
//   - the moon: a cratered sphere with a correct phase. The world turns by moving the sun around the pole, so the moon
//     rides along with it at a fixed angle (EXT_MOON_AZ) from the sun: it rises and sets everywhere, keeps a waxing
//     gibbous phase, and in the opening orbit shot (sun=0.9) it hangs in the upper right of the frame
//   - moonlight on land (nightSurfaceGlow), on clouds, a moon glitter path on the sea, a moonlit night sky
//   - lightning flashes inside thick clouds on the night side
//   - bioluminescent surf: a faint blue shimmer only where night water is a few metres deep at the shore
export const EXTRAS = /* glsl */ `
const float EXT_AUR_LO  = PLANET_R + 3800.0;
const float EXT_AUR_HI  = PLANET_R + 12500.0;
const float EXT_AUR_Y0  = 50000.0;              // |y| range that can hold aurora (the ovals sit between ~53 and ~76 degrees)
const float EXT_AUR_Y1  = EXT_AUR_HI;
const float EXT_AG_R    = PLANET_R + 4600.0;    // airglow layer
const float EXT_AG_S    = 380.0;
const float EXT_MOON_RAD = 0.026;               // angular radius (~1.5 deg)
const float EXT_MOON_EL  = -0.119;              // moon elevation above the equator plane (rad)
const float EXT_MOON_AZ  = 3.88;                // moon azimuth relative to the sun (rad)
const vec3  EXT_MOON_TINT = vec3(0.60, 0.74, 1.0);   // moonlight as the eye sees it at night (Purkinje blue)

vec3 extMoonDir() { return moonDirection(); }   // defined in common.js (EXT_MOON_AZ/EL document the values)
// moonlight irradiance scale (outside the atmosphere), grows with the lit fraction of the disc
vec3 extMoonE(vec3 md) {
  float k = 0.5 - 0.5 * dot(md, uSunDir);
  return EXT_MOON_TINT * 0.24 * k * k;
}
// Approximate transmittance from altitude h toward direction cosine mu (0 below the horizon). Self-contained on purpose
// (matches the atmosphere's Rayleigh/Mie columns closely enough for moonlight and for dimming things near the horizon).
const vec3 EXT_TAU_R = vec3(5.8e-6, 13.5e-6, 33.1e-6) * 6.0 * 1600.0;
vec3 extTrans(float h, float mu) {
  h = max(h, 0.0);
  float m = max(mu, 0.0);
  float am = 1.0 / (m + 0.13 * exp(-7.7 * m));            // air mass; ~7.7 at the horizon of this small planet
  vec3 tau = EXT_TAU_R * exp(-h / 1600.0) + 0.053 * exp(-h / 380.0);
  float muH = -sqrt(2.0 * h / PLANET_R);                   // the horizon dips as you climb
  return exp(-tau * am) * smoothstep(muH - 0.04, muH + 0.04, mu);
}
float extPhaseR(float c) { return 0.0597 * (1.0 + c * c); }
float extPhaseM(float c) { return 0.0189 / pow(max(1.64 - 1.6 * c, 1e-4), 1.5); }

float extJitter() {
  float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  return fract(ign + uTime * 0.61803);
}

// ---------------------------------------------------------------- aurora
vec2 extSlab(vec3 ro, vec3 rd, float y0, float y1) {
  if (abs(rd.y) < 1e-6) return (ro.y > y0 && ro.y < y1) ? vec2(-1e12, 1e12) : vec2(1.0, -1.0);
  float a = (y0 - ro.y) / rd.y, b = (y1 - ro.y) / rd.y;
  return vec2(min(a, b), max(a, b));
}
vec2 extClip(vec2 a, vec2 b) { return vec2(max(a.x, b.x), min(a.y, b.y)); }
float extLen(vec2 s) { return max(s.y - s.x, 0.0); }

vec3 extAurora(vec3 ro, vec3 rd, float tHit, float jit) {
  vec2 o = raySphere(ro, rd, EXT_AUR_HI);
  if (o.y <= 0.0) return vec3(0.0);
  float a0 = max(o.x, 0.0), a1 = min(o.y, tHit);
  if (a1 <= a0) return vec3(0.0);
  // the shell minus the inner sphere: up to two pieces of ray
  vec2 s1 = vec2(a0, a1), s2 = vec2(1.0, 0.0);
  vec2 i = raySphere(ro, rd, EXT_AUR_LO);
  if (i.y > 0.0) { s1 = vec2(a0, min(a1, i.x)); s2 = vec2(max(a0, i.y), a1); }
  // ...clipped to the polar slab (the ovals sit between ~58 and ~74 degrees of latitude)
  vec2 sn = extSlab(ro, rd, EXT_AUR_Y0, EXT_AUR_Y1), ss = extSlab(ro, rd, -EXT_AUR_Y1, -EXT_AUR_Y0);
  vec2 n1 = extClip(s1, sn), n2 = extClip(s2, sn);
  vec2 m1 = extClip(s1, ss), m2 = extClip(s2, ss);
  float ln = extLen(n1) + extLen(n2), ls = extLen(m1) + extLen(m2);
  if (ln <= 0.0 && ls <= 0.0) return vec3(0.0);
  if (ls > ln) { n1 = m1; n2 = m2; }
  float L1 = extLen(n1), L = L1 + extLen(n2);

  // per-ray: how active this stretch of the oval is (bright surges drift around the ring)
  vec3 pm = ro + rd * (L1 > 0.0 ? n1.x + 0.5 * L1 : n2.x + 0.5 * (L - L1));
  float act = 0.25 + 1.1 * smoothstep(-0.45, 0.55, noise3(normalize(pm) * 2.3 + vec3(uTime * 0.021, 0.0, -uTime * 0.017)));
  act *= 0.85 + 0.15 * sin(uTime * 1.7 + pm.x * 0.0002);

  vec2 sunH = normalize(uSunDir.xz + vec2(1e-5));
  float pixA = 2.0 / (uRes.y * uFocal);
  int N = uQuality == 0 ? 14 : (uQuality == 1 ? 30 : 56);
  float dt = L / float(N);
  vec3 acc = vec3(0.0);
  float tt = uTime;
  for (int k = 0; k < 56; k++) {
    if (k >= N) break;
    float u = (float(k) + jit) * dt;
    float t = u < L1 ? n1.x + u : n2.x + (u - L1);
    vec3 p = ro + rd * t;
    float r = length(p);
    vec3 s = p / r;
    float sunUp = dot(s, uSunDir);
    if (sunUp > 0.12) continue;
    float hh = (r - EXT_AUR_LO) / (EXT_AUR_HI - EXT_AUR_LO);
    float rho = length(s.xz);                       // cos(latitude)
    float anti = -dot(s.xz / max(rho, 1e-4), sunH);  // +1 on the midnight side: the oval bulges equatorward there
    float w = 0.405 + 0.045 * anti
            + 0.032 * noise3(s * 4.0 + vec3(0.0, tt * 0.035, 0.0))
            + 0.011 * noise3(s * 13.0 + vec3(tt * 0.05, 0.0, -tt * 0.04));
    float d = rho - w;
    // thin sheets are widened (keeping their integral) to what one sample step / one pixel can resolve, so they
    // read as a smooth glowing band from orbit instead of sparkling
    float pf = t * pixA;                                       // pixel footprint, metres
    float hzc = length(rd - s * dot(rd, s));                   // horizontal part of the ray
    float blur2 = (0.6 * dt * hzc / r) * (0.6 * dt * hzc / r) + (0.7 * pf / r) * (0.7 * pf / r);
    float wa = sqrt(0.0045 * 0.0045 + blur2), wb = sqrt(0.0035 * 0.0035 + blur2);
    float sheetA = (0.0045 / wa) * exp(-d * d / (wa * wa));
    float d2 = d + 0.027;
    float sheetB = 0.55 * (0.0035 / wb) * exp(-d2 * d2 / (wb * wb));
    float glow = 0.10 * exp(-d * d * (1.0 / (0.028 * 0.028)));
    if (sheetA + sheetB + glow < 0.004) continue;
    // vertical rays: a fine pattern in horizontal position only, sliding along the curtain
    float nr = noise3(s * 270.0 + vec3(tt * 0.5, tt * 0.12, -tt * 0.3));
    float nc = noise3(s * 60.0 + vec3(-tt * 0.15, 0.0, tt * 0.1));
    float fine = 1.0 - smoothstep(60.0, 300.0, pf);
    nr *= fine;
    float rays = (0.25 + 0.75 * (0.5 + 0.5 * nr) * (0.5 + 0.5 * nr)) * (0.45 + 0.55 * smoothstep(-0.5, 0.5, nc * (0.3 + 0.7 * fine)));
    // height profile: sharp, ragged lower edge, green fading upward into a magenta top
    float hb = 0.035 + 0.09 * (0.5 - 0.5 * nr);
    float x = hh - hb;
    float green = smoothstep(0.0, 0.04, x) * exp(-max(x, 0.0) * 3.4);
    float top = smoothstep(0.28, 0.75, hh) * (1.0 - smoothstep(0.82, 1.0, hh));
    float fringe = exp(-x * x * (1.0 / (0.018 * 0.018)));
    vec3 c = vec3(0.10, 1.0, 0.36) * green + vec3(0.55, 0.08, 0.50) * top * 0.30 + vec3(0.8, 0.2, 0.5) * fringe * 0.12;
    float dark = smoothstep(0.12, -0.10, sunUp);
    acc += c * ((sheetA + sheetB) * rays + glow * (0.6 + 0.4 * rays)) * (dark * dt);
  }
  return acc * act * 0.0014;
}

// ---------------------------------------------------------------- airglow (no loop)
// column through the layer for one crossing; the extra (k/(D+k))^0.75 keeps the limb a thin line on this small planet
float extAgCross(float D) {
  float k = 2.0 * EXT_AG_R * EXT_AG_S;
  float x = k / (max(D, 0.0) + k);
  return EXT_AG_S * 1.7725 * EXT_AG_R * inversesqrt(max(D, 0.0) + k) * pow(x, 0.75);
}
float extAgNight(vec3 p) { return smoothstep(0.05, -0.2, dot(normalize(p), uSunDir)); }

vec3 extAirglow(vec3 ro, vec3 rd, float tHit) {
  float tm = -dot(ro, rd);
  float b2 = max(dot(ro, ro) - tm * tm, 0.0);
  float D = EXT_AG_R * EXT_AG_R - b2;
  float col = 0.0;
  if (D > 0.0) {
    float sq = sqrt(D), A = extAgCross(D);
    float tn = tm - sq, tf = tm + sq;
    if (tn > 0.0 && tn < tHit) col += A * extAgNight(ro + rd * tn);
    if (tf > 0.0 && tf < tHit) col += A * extAgNight(ro + rd * tf);
  } else {
    float b = sqrt(b2);
    if (b > EXT_AG_R + 3.0 * EXT_AG_S || tm <= 0.0 || tm >= tHit) return vec3(0.0);
    float e = (b - EXT_AG_R) / EXT_AG_S;
    col = 2.0 * extAgCross(0.0) * exp(-e * e) * extAgNight(ro + rd * tm);
  }
  return vec3(0.30, 0.95, 0.42) * col * 3.2e-6;
}

// ---------------------------------------------------------------- moon
// craters: one candidate per cell (centre and radius keep it inside its cell, so no neighbour search)
vec3 extCraters(vec3 n, inout float alb) {
  vec3 g = vec3(0.0);
  for (int k = 0; k < 4; k++) {
    float sc = 4.0 * pow(2.1, float(k));
    vec3 q = n * sc + vec3(float(k) * 17.3, float(k) * 5.1, -float(k) * 9.7);
    ivec3 c = ivec3(floor(q));
    float h = hash3(c + ivec3(k * 131, 7, 3));
    if (h < 0.35) continue;
    vec3 jv = vec3(hash3(c + ivec3(1, 50, 9)), hash3(c + ivec3(2, 9, 61)), hash3(c + ivec3(70, 3, 5))) - 0.5;
    vec3 cen = vec3(c) + 0.5 + jv * 0.2;
    float rad = 0.12 + 0.16 * fract(h * 13.7);
    vec3 dv = q - cen;
    float dl = length(dv);
    float d = dl / rad;
    if (d > 1.6) continue;
    float rim = exp(-(d - 1.0) * (d - 1.0) * 20.0);
    float dh = (d < 1.0 ? 1.4 * d : 0.0) - rim * 12.0 * (d - 1.0) * 0.35;
    g += dv / max(dl, 1e-5) * dh * (0.55 / (1.0 + float(k) * 0.4));
    alb *= 1.0 + 0.12 * rim - (d < 1.0 ? 0.06 : 0.0) + (fract(h * 71.0) > 0.85 ? 0.35 * exp(-d * 1.2) : 0.0);
  }
  return g;
}

vec3 extMoon(vec3 rd, vec3 md, float occl) {
  float c = dot(rd, md);
  if (c < 0.994) return vec3(0.0);
  vec3 mr = normalize(cross(md, vec3(0.0, 1.0, 0.0)));
  vec3 mu = cross(mr, md);
  vec2 q = vec2(dot(rd, mr), dot(rd, mu)) / EXT_MOON_RAD;
  float r = length(q);
  float kLit = 0.5 - 0.5 * dot(md, uSunDir);
  float pix = 2.0 / (uRes.y * uFocal * EXT_MOON_RAD);
  vec3 col = vec3(0.0);
  // a soft aureole (stronger when seen through air)
  col += vec3(0.55, 0.62, 0.8) * kLit * kLit * 0.05 * exp(-max(r - 1.0, 0.0) * 1.6);
  if (r < 1.0 + pix) {
    float r2 = min(r * r, 1.0);
    vec3 nl = vec3(q, sqrt(1.0 - r2));            // fixed face: the same side always faces the planet
    float m = noise3(nl * 1.6 + 3.1) * 0.65 + noise3(nl * 3.7 - 1.3) * 0.35;
    float alb = mix(0.21, 0.10, smoothstep(0.02, 0.22, m)) * (0.9 + 0.1 * noise3(nl * 24.0));
    vec3 g = extCraters(nl, alb);
    vec3 nb = normalize(nl - (g - dot(g, nl) * nl) * 0.09);
    vec3 n = nb.x * mr + nb.y * mu - nb.z * md;
    vec3 n0 = nl.x * mr + nl.y * mu - nl.z * md;
    float mu0 = dot(n, uSunDir), mv = max(dot(n0, -rd), 0.05);
    float lit = mu0 > 0.0 ? 1.4 * mu0 / (mu0 + mv) + 0.6 * mu0 : 0.0;   // Lommel-Seeliger + a little Lambert
    float shine = 0.012 * (0.5 + 0.5 * dot(md, uSunDir));               // planetshine on the night part
    vec3 disc = vec3(1.0, 0.96, 0.9) * alb * (lit * 9.0 + shine);
    col += disc * (1.0 - smoothstep(1.0 - pix, 1.0 + pix, r));
  }
  return col * occl;
}

// ---------------------------------------------------------------- lightning
vec3 extLightning(vec3 dir, float cov) {
  if (cov < 0.5) return vec3(0.0);
  vec3 q = dir * 8.0;
  ivec3 c = ivec3(floor(q));
  float h1 = hash3(c + ivec3(11, 0, 0)), h2 = hash3(c + ivec3(0, 23, 0)), h3 = hash3(c + ivec3(0, 0, 37));
  if (h3 < 0.45) return vec3(0.0);                   // not a storm cell
  float period = 2.2 + 5.5 * h1;
  float ph = uTime / period + h2 * 9.0;
  float cyc = floor(ph);
  float f = fract(ph) * period;                      // seconds since this cycle began
  if (f > 0.7) return vec3(0.0);
  if (hash3(c + ivec3(int(mod(cyc, 997.0)), 5, 9)) < 0.4) return vec3(0.0);   // this cycle stays quiet
  float env = exp(-f * 10.0) + 0.75 * step(0.11, f) * exp(-(f - 0.11) * 16.0) + 0.5 * step(0.27, f) * exp(-(f - 0.27) * 20.0);
  vec3 cen = vec3(c) + 0.5 + (vec3(h1, h2, fract(h3 * 31.0)) - 0.5) * 0.3;
  float dd = length(q - cen);
  float glow = exp(-dd * dd * 40.0) + 0.3 * exp(-dd * dd * 12.0) * step(dd, 0.35);
  glow *= 1.0 - smoothstep(0.28, 0.35, dd);
  return vec3(0.72, 0.78, 1.0) * glow * env * smoothstep(0.5, 0.85, cov) * 3.5;
}

// ---------------------------------------------------------------- bioluminescent surf
vec3 extBiolum(vec3 p, vec3 up, float t, float night) {
  if (terrainHeight(up, 2) < -150.0) return vec3(0.0);     // cheap coarse test: open ocean is never near a shore
  int o = int(clamp(9.0 - log2(1.0 + t / 250.0) * 1.6, 3.0, uQuality == 0 ? 5.0 : 9.0));
  float depth = max(-terrainHeight(up, o), 0.0);
  if (depth > 14.0) return vec3(0.0);
  float wob = noise3(p * 0.015 + vec3(0.0, uTime * 0.05, 0.0));
  float wave = 0.5 + 0.5 * sin(depth * 2.2 - uTime * 1.3 + wob * 4.0);   // crests rolling toward the shore
  float surf = exp(-depth * 0.7) * (0.3 + 0.7 * pow(wave, 6.0));
  float far = smoothstep(2.0, 12.0, t * 2.0 / (uRes.y * uFocal));
  float spark = far > 0.99 ? 0.2 : mix(smoothstep(0.35, 0.9, noise3(p * 0.45 + vec3(uTime * 0.4, -uTime * 0.25, uTime * 0.3))), 0.2, far);
  float g = surf * (0.5 + 1.5 * spark) + 0.06 * exp(-depth * 0.25);
  float fade = 1.0 / (1.0 + t * 0.00012);            // nothing but a thin outline from far away
  return vec3(0.08, 0.6, 1.0) * g * night * fade * 0.16;
}

// ---------------------------------------------------------------- contract
vec3 extrasEmission(vec3 ro, vec3 rd, float tHit) {
  float camR = length(ro);
  vec3 camUp = ro / camR;
  float camH = camR - PLANET_R;
  float camSun = dot(camUp, uSunDir);
  bool inAir = camR < ATMO_R;
  vec3 md = extMoonDir();
  vec3 mE = extMoonE(md);
  bool sky = tHit > 1e11;
  float jit = extJitter();

  // cloud shell along the ray (coverage is only evaluated when something needs it)
  vec2 cs = raySphere(ro, rd, CLOUD_R);
  float tc = cs.y <= 0.0 ? -1.0 : (cs.x > 0.0 ? cs.x : cs.y);
  bool hasCloud = tc > 0.0 && tc < tHit;
  vec3 cUp = normalize(ro + rd * max(tc, 0.0));
  float cSun = dot(cUp, uSunDir);
  bool nearMoon = sky && dot(rd, md) > 0.994;
  float cov = 0.0;
  if (hasCloud && (cSun < 0.2 || (camR < CLOUD_R && (camSun < 0.25 || nearMoon)))) cov = cloudCoverage(cUp);

  vec3 col = vec3(0.0);
  // ---- light from beyond the clouds when we're under them: aurora, airglow, moon
  vec3 far = extAurora(ro, rd, tHit, jit) + extAirglow(ro, rd, tHit);
  if (sky) far += extMoon(rd, md, 1.0);
  if (inAir) far *= extTrans(camH, dot(camUp, rd)) * 0.85 + 0.15;   // dimmer and redder near the horizon
  col += far * (camR < CLOUD_R ? 1.0 - cov : 1.0);

  // ---- moonlit night sky (only from inside the atmosphere)
  if (inAir && camSun < 0.15) {
    float mUpC = dot(camUp, md);
    if (mUpC > -0.2) {
      vec3 Tv = sky ? extTrans(camH, dot(camUp, rd)) : exp(-EXT_TAU_R / 1600.0 * min(tHit, 60000.0) * exp(-camH / 1600.0));
      float cm = dot(rd, md);
      vec3 s = (EXT_TAU_R / EXT_TAU_R.z) * extPhaseR(cm) * 0.9 + vec3(0.6, 0.65, 0.75) * extPhaseM(cm) * 0.05;
      col += mE * s * (vec3(1.0) - Tv) * smoothstep(-0.2, 0.2, mUpC) * smoothstep(0.15, -0.1, camSun) * 0.35;
    }
  }

  // ---- clouds on the night side: moonlight and lightning
  if (hasCloud && cSun < 0.2 && cov > 0.001) {
    float night = smoothstep(0.2, -0.05, cSun);
    float mUp = dot(cUp, md);
    vec3 cl = vec3(0.004, 0.005, 0.007);                                   // starlight
    if (mUp > -0.15) cl += mE * extTrans(CLOUD_R - PLANET_R, mUp) * (0.75 + 0.25 * cov) * 0.45;
    col += cl * cov * night;
    col += extLightning(cUp, cov) * night * (camR < CLOUD_R ? 0.55 : 1.0);
  }

  // ---- the night sea: moon glitter, bioluminescent surf
  if (!sky) {
    vec3 p = ro + rd * tHit;
    float pr = length(p);
    vec3 up = p / pr;
    float sUp = dot(up, uSunDir);
    if (abs(pr - PLANET_R) < 0.12 && sUp < 0.15) {
      float night = smoothstep(0.15, -0.08, sUp);
      vec3 sea = vec3(0.0);
      float mUp = dot(up, md);
      if (mUp > -0.05) {
        vec3 hv = normalize(md - rd);
        float nh = max(dot(up, hv), 0.0);
        float ndv = max(dot(up, -rd), 0.0);
        float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
        float far = smoothstep(3.0, 30.0, tHit * 2.0 / (uRes.y * uFocal));     // glitter averages out with distance
        float spark = far > 0.99 ? 0.33 : mix(smoothstep(0.1, 0.8, noise3(p * 0.055 + vec3(0.0, uTime * 0.9, uTime * 0.3))), 0.33, far);
        float glint = pow(nh, 260.0) * (0.3 + 3.0 * spark) * 6.0 + pow(nh, 30.0) * 0.08;
        vec3 Tm = extTrans(0.0, mUp);
        sea += mE * Tm * (glint * (0.25 + 0.75 * fres) + 0.02 * mUp) + mE * fres * 0.05 * smoothstep(-0.05, 0.3, mUp);
      }
      if (tHit < 60000.0 || uQuality > 0) sea += extBiolum(p, up, tHit, night);
      col += sea * night * (hasCloud ? 1.0 - cov : 1.0);
    }
  }
  return col;
}

// moonlight and faint starlight on the dark side of the land
vec3 nightSurfaceGlow(vec3 p, vec3 n) {
  vec3 up = normalize(p);
  float sUp = dot(up, uSunDir);
  if (sUp > 0.2) return vec3(0.0);
  float night = smoothstep(0.2, -0.05, sUp);
  vec3 md = extMoonDir();
  float mUp = dot(up, md);
  vec3 E = vec3(0.006, 0.0075, 0.011) * (0.6 + 0.4 * dot(n, up));        // starlight + airglow ambient
  if (mUp > -0.15) {
    vec3 mE = extMoonE(md);
    float h = length(p) - PLANET_R;
    float cshade = 1.0;
    if (uQuality > 0) {
      vec2 s = raySphere(p, md, CLOUD_R);
      cshade = 1.0 - 0.8 * cloudCoverage(normalize(p + md * s.y));
    }
    E += mE * extTrans(h, mUp) * max(dot(n, md), 0.0) * cshade;
    E += mE * vec3(0.35, 0.5, 1.0) * 0.07 * smoothstep(-0.15, 0.3, mUp) * (0.6 + 0.4 * dot(n, up));
  }
  // a cheap stand-in for the terrain's albedo (snow, rock, vegetation, sand), so this stays independent of terrain.js
  float h = length(p) - PLANET_R, slope = dot(n, up), lat = abs(up.y);
  vec3 alb = mix(vec3(0.24, 0.21, 0.18), vec3(0.11, 0.14, 0.07), smoothstep(0.75, 0.88, slope) * (1.0 - smoothstep(500.0, 700.0, h)));
  alb = mix(alb, vec3(0.6, 0.54, 0.4), smoothstep(6.0, 1.0, h) * smoothstep(0.6, 0.8, slope));
  float snow = clamp(smoothstep(0.76, 0.84, lat) + smoothstep(650.0, 800.0, h) * smoothstep(0.5, 0.75, slope), 0.0, 1.0);
  alb = mix(alb, vec3(0.88, 0.92, 0.97), snow);
  return alb * E * night;
}
`;
