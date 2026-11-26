// Atmosphere: physically based Rayleigh + Mie + ozone scattering around the planet, with an approximate
// multiple-scattering term, plus the space background (stars, Milky Way, sun).
// OWNER: atmosphere agent.
//
// CONTRACT (functions other modules call; keep these signatures):
//   vec3 sunTransmittance(vec3 p)                      light reaching point p from the sun (0 in the planet's shadow), unitless [0,1]
//   vec3 sunLight(vec3 p)                              = SUN_E * sunTransmittance(p)   (radiance-scaled sunlight at p)
//   vec3 skyAmbient(vec3 p, vec3 n)                    irradiance from the sky dome onto a surface with normal n at p
//                                                      (same convention as sunLight: surface radiance = albedo * (sunLight*NdotL + skyAmbient))
//   void atmosphere(vec3 ro, vec3 rd, float tEnd, float jitter, out vec3 inscatter, out vec3 trans)
//                                                      light scattered toward the camera along ro->ro+rd*tEnd, and transmittance.
//                                                      jitter in [0,1): per-pixel/per-frame random; it only nudges a faint
//                                                      screen-space dither (no visible flicker). jitter == 0.5 means no dither.
//   vec3 skyRadiance(vec3 p, vec3 dir)                 what you'd see looking from p along dir to space (atmosphere + space background)
//   vec3 spaceBackground(vec3 rd, bool withSun)        stars, Milky Way, sun disc etc. outside the atmosphere. withSun = true only for
//                                                      camera rays: it adds the sun disc and its lens glare (and assumes rd starts at uCamPos)
//
// JS side: TRANS_LUT_FS renders the lookup table once (main.js: LUT_W x LUT_H, RGBA8). Layout, in texels:
//   rows  0..63            transmittance to the sun, sqrt-encoded          (u: sun zenith cosine, v: altitude)
//   rows 64..79, x   0..127 sky irradiance for an upward-facing surface, sqrt-encoded, in SUN_E units
//   rows 64..79, x 128..255 isotropic multiple-scattering radiance (all orders >= 2), sqrt-encoded, in SUN_E units
// Every table uses the same (altitude, sun zenith cosine) parameterisation, so one transUV() serves all three.
export const TRANS_LUT_W = 256, TRANS_LUT_H = 80;

export const ATMOSPHERE = /* glsl */ `
const vec3  BETA_R = vec3(5.8e-6, 13.5e-6, 33.1e-6) * 5.5;   // Rayleigh scattering at sea level (1/m)
const float BETA_M = 21e-6 * 2.6;                            // Mie scattering at sea level (extinction = 1.11x)
const vec3  ATM_MIE_TINT = vec3(0.86, 0.97, 1.15);           // aerosols scatter blue a little more (Angstrom slope)
const float H_R = 1750.0, H_M = 420.0, MIE_G = 0.76;
const vec3  BETA_O = vec3(0.650e-6, 1.881e-6, 0.085e-6) * 7.0;   // ozone absorption at the layer peak
const float OZ_C = 6000.0, OZ_W = 4500.0;                        // ozone layer centre / half width (tent profile)
const float ATM_GROUND_ALB = 0.12;                                // mean albedo of the planet as seen by the sky
const float ATM_SKY_SCALE = 0.5;                                  // encoding range of the irradiance / MS tables
const vec2  ATM_LUT_SIZE = vec2(${TRANS_LUT_W}.0, ${TRANS_LUT_H}.0);
const vec4  ATM_REG_T   = vec4(0.0, 0.0, 256.0, 64.0);            // texel regions: x0, y0, width, height
const vec4  ATM_REG_AMB = vec4(0.0, 64.0, 128.0, 16.0);
const vec4  ATM_REG_MS  = vec4(128.0, 64.0, 128.0, 16.0);
const float ATM_SUN_ANG = 0.0155;                                 // angular radius of the sun disc (rad)
const float ATM_LOWSUN = 2.0;                                     // extra air mass for a sun at the horizon (see lutTrans)

// ---------- shared helpers ----------
// (rayleigh, mie, ozone) relative densities at altitude h
vec3 atmoDensity(float h) {
  return vec3(exp(-h / H_R), exp(-h / H_M), max(0.0, 1.0 - abs(h - OZ_C) / OZ_W));
}
vec3 atmoExtinction(vec3 d) { return BETA_R * d.x + (BETA_M * 1.11 * d.y) * ATM_MIE_TINT + BETA_O * d.z; }

// Maps x in [0,1] to a distance in [t0,t1], with samples crowded quadratically around tm (the lowest, densest
// point of the segment). Cheap stand-in for an exponential distribution that also works for limb rays from orbit.
float atmoWarp(float x, float t0, float t1, float tm) {
  float a = (tm - t0) / max(t1 - t0, 1e-3);
  if (x < a) { float s = (a - x) / a; return tm - (tm - t0) * s * s; }
  float s = (x - a) / max(1.0 - a, 1e-6);
  return tm + (t1 - tm) * s * s;
}

// LUT parameterisation: u = view zenith cosine (sqrt-warped around the horizon), v = sqrt(altitude fraction)
vec2 transUV(float h, float mu) {
  float u = 0.5 + 0.5 * sign(mu) * sqrt(abs(mu));
  float v = sqrt(clamp(h / (ATMO_R - PLANET_R), 0.0, 1.0));
  return vec2(u, v);
}
vec3 atmoLUT(vec2 uv, vec4 reg) {
  vec2 px = reg.xy + clamp(uv * reg.zw, vec2(0.5), reg.zw - 0.5);
  return texture(uTransLUT, px / ATM_LUT_SIZE).rgb;
}
vec3 atmoTransLUT(vec2 uv) { vec3 s = atmoLUT(uv, ATM_REG_T);   return s * s; }
vec3 atmoAmbLUT(vec2 uv)   { vec3 s = atmoLUT(uv, ATM_REG_AMB); return s * s * ATM_SKY_SCALE; }
vec3 atmoMSLUT(vec2 uv)    { vec3 s = atmoLUT(uv, ATM_REG_MS);  return s * s * ATM_SKY_SCALE; }

vec3 sunTransmittance(vec3 p) {
  float r = length(p);
  return atmoTransLUT(transUV(r - PLANET_R, dot(p, uSunDir) / r));
}
vec3 sunLight(vec3 p) { return SUN_E * sunTransmittance(p); }

float phaseR(float mu) { return 3.0 / (16.0 * PI) * (1.0 + mu * mu); }
float phaseM(float mu) {
  float g = MIE_G;
  return 3.0 / (8.0 * PI) * ((1.0 - g * g) * (1.0 + mu * mu)) / ((2.0 + g * g) * pow(max(1.0 + g * g - 2.0 * g * mu, 1e-4), 1.5));
}

vec3 skyAmbient(vec3 p, vec3 n) {
  float r = length(p);
  vec3 up = p / r;
  float muS = dot(up, uSunDir);
  vec2 uv = transUV(r - PLANET_R, muS);
  vec3 amb = atmoAmbLUT(uv);
  float nu = dot(n, up);
  // the sky is brighter on the sun's side: tilt the dome lighting toward the sun's azimuth
  vec3 sh = uSunDir - up * muS;
  float shl = length(sh);
  float side = shl > 1e-4 ? dot(n, sh) / shl : 0.0;
  vec3 sky = amb * max(0.5 + 0.5 * nu + 0.18 * side * (1.0 - abs(nu)), 0.0);
  // light bounced off the ground below (seen by surfaces that face sideways or down)
  vec3 ground = ATM_GROUND_ALB * (atmoTransLUT(uv) * max(muS, 0.0) + amb) * (0.5 - 0.5 * nu);
  return SUN_E * (sky + ground);
}

// Interleaved gradient noise: a well-spread per-pixel dither pattern.
float atmoDither() {
  return fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
}

void atmoMarch(vec3 ro, vec3 rd, float tEnd, float j, int n, out vec3 L, out vec3 T) {
  L = vec3(0.0); T = vec3(1.0);
  vec2 a = raySphere(ro, rd, ATMO_R);
  if (a.y <= 0.0) return;
  float t0 = max(a.x, 0.0), t1 = min(a.y, tEnd);
  if (t1 <= t0) return;
  float tm = clamp(-dot(ro, rd), t0, t1);
  float mu = dot(rd, uSunDir);
  float pR = phaseR(mu) * PI, pM = phaseM(mu) * PI;   // PI: sunlight irradiance is PI * SUN_E in the surface convention
  float fn = float(n), tPrev = t0;
  for (int i = 0; i < 32; i++) {
    if (i >= n) break;
    float tNext = atmoWarp(float(i + 1) / fn, t0, t1, tm);
    float t = atmoWarp((float(i) + j) / fn, t0, t1, tm);
    float dt = tNext - tPrev;
    tPrev = tNext;
    vec3 p = ro + rd * t;
    float r = length(p);
    float h = max(r - PLANET_R, 0.0);
    vec3 d = atmoDensity(h);
    vec3 ext = atmoExtinction(d);
    vec3 sR = BETA_R * d.x;
    vec3 sM = BETA_M * d.y * ATM_MIE_TINT;
    vec2 uv = transUV(h, dot(p, uSunDir) / r);
    vec3 scat = (sR * pR + sM * pM) * atmoTransLUT(uv) + (sR + sM) * atmoMSLUT(uv);
    vec3 stepT = exp(-ext * dt);
    L += T * scat * (1.0 - stepT) / max(ext, vec3(1e-12));
    T *= stepT;
  }
  L *= SUN_E;
}

void atmosphere(vec3 ro, vec3 rd, float tEnd, float jitter, out vec3 inscatter, out vec3 trans) {
  int n = uQuality == 2 ? 28 : (uQuality == 1 ? 16 : 10);
  // The warped step distribution is already smooth, so only a faint dither is needed to break up banding:
  // interleaved gradient noise (well spread in screen space) shifted by the caller's per-frame jitter, so a still
  // camera's temporal accumulation still converges, at an amplitude too small to flicker while moving.
  float j = jitter == 0.5 ? 0.5 : 0.5 + 0.3 * (fract(atmoDither() + jitter) - 0.5);
  atmoMarch(ro, rd, tEnd, j, n, inscatter, trans);
}

// ---------- space ----------
const vec3 ATM_GAL_N = vec3(-0.5757, 0.8017, -0.1610);   // galactic pole
const vec3 ATM_GAL_C = vec3(0.0956, -0.1295, -0.9870);   // direction of the galactic core (in the galactic plane)

float atmoPixelAngle() { return 2.0 / (uRes.y * max(uFocal, 0.1)); }

// One layer of stars on a 3D lattice: at most one star per cell, drawn only in the cell its direction falls in.
vec3 atmoStarLayer(vec3 rd, float cells, float prob, float px, float bright) {
  ivec3 c = ivec3(floor(rd * cells));
  float h0 = hash3(c);
  if (h0 >= prob) return vec3(0.0);
  vec3 o = vec3(hash3(c + ivec3(37, 11, 5)), hash3(c + ivec3(3, 71, 29)), hash3(c + ivec3(13, 7, 83)));
  vec3 sp = normalize(vec3(c) + 0.2 + 0.6 * o);
  vec3 f = sp * cells - vec3(c);
  if (min(f.x, min(f.y, f.z)) < 0.0 || max(f.x, max(f.y, f.z)) > 1.0) return vec3(0.0);
  vec3 dv = rd - sp;
  // ~0.7 px wide, but never wider than the cell allows (else stars clip into squares at low resolution);
  // shrinking stars keep their energy, up to a cap, so the field doesn't fade at low res
  float s0 = px * 0.7, s = min(s0, 0.14 / cells);
  float k = exp(-0.5 * dot(dv, dv) / (s * s)) * min(s0 * s0 / (s * s), 4.0);
  float mag = h0 / prob;                                   // uniform in [0,1): few bright, many faint
  float flux = bright * exp(-6.5 * mag);
  vec3 tint = mix(vec3(0.62, 0.74, 1.0), vec3(1.0, 0.80, 0.58), o.x * o.x);
  tint = mix(tint, vec3(1.0, 0.55, 0.40), step(0.93, o.y));   // the odd red giant
  return tint * flux * k;
}

// Milky Way: patchy glow of unresolved stars, a warm bulge, a wavy dark rift and faint pink nebulae.
// Returns rgb glow and, in w, how much to crowd the faint star layer.
vec4 atmoMilkyWay(vec3 rd) {
  float b = dot(rd, ATM_GAL_N);
  float core = exp((dot(rd, ATM_GAL_C) - 1.0) * 9.0);
  float band = exp(-b * b * 60.0 / (1.0 + 3.0 * core));     // thicker around the bulge
  if (band < 0.01) return vec4(0.0);
  vec3 q = rd * 9.0;
  float n = 0.45 * noise3(q) + 0.35 * noise3(M3 * q * 2.7);
  if (uQuality > 0) n += 0.25 * noise3(M3 * q * 6.3);
  float glow = band * (0.08 + 0.92 * smoothstep(-0.45, 0.65, n)) * (0.6 + 3.0 * core);
  float rift = (b - 0.012 + 0.035 * noise3(rd * 4.0 + 7.0)) * 32.0;
  glow *= 1.0 - 0.8 * exp(-rift * rift) * smoothstep(-0.35, 0.25, noise3(rd * 2.5 + 1.0));
  if (uQuality > 0) glow *= 1.0 - 0.45 * smoothstep(0.15, 0.65, noise3(rd * 23.0)) * exp(-b * b * 150.0);
  vec3 col = mix(vec3(0.70, 0.80, 1.0), vec3(1.0, 0.88, 0.72), smoothstep(0.2, 0.9, core)) * glow;
  col += band * smoothstep(0.42, 0.85, noise3(rd * 6.0 + 11.0) + 0.3 * n) * vec3(0.9, 0.28, 0.42) * 0.7;
  return vec4(col, glow);
}

// The sun as the camera sees it: limb-darkened disc plus a lens glare/bloom halo (no post pass needed).
// Only drawn where the view ray reaches space; the caller's atmospheric transmittance tints and dims it.
vec3 atmoSunDisc(vec3 rd, float px) {
  float m = dot(rd, uSunDir);
  if (m <= 0.0 || raySphere(uCamPos, uSunDir, PLANET_R).x > 0.0) return vec3(0.0);   // behind the planet
  float g = 1.2 * exp((m - 1.0) * 2.0e4) + 0.12 * exp((m - 1.0) * 1.5e3) + 0.015 * exp((m - 1.0) * 70.0);
  float x = sqrt(2.0 * (1.0 - m)) / ATM_SUN_ANG;                       // 0 centre .. 1 rim
  float aa = max(px / ATM_SUN_ANG, 0.02);
  float disc = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, x);
  float limb = 0.45 + 0.55 * sqrt(max(1.0 - x * x, 0.0));             // limb darkening
  return SUN_E * (40.0 * disc * limb + g);
}

vec3 spaceBackground(vec3 rd, bool withSun) {
  float px = atmoPixelAngle();
  // the eye can't pick out stars against a bright sky: fade them with the sky brightness around the camera
  float rc = length(uCamPos);
  vec3 skyC = atmoAmbLUT(transUV(rc - PLANET_R, dot(uCamPos, uSunDir) / rc));
  float lum = dot(skyC, vec3(0.2, 0.7, 0.1)) / 6e-4;
  float vis = 1.0 / (1.0 + lum * lum);
  if (vis < 0.01) return withSun ? atmoSunDisc(rd, px) : vec3(0.0);
  vec4 mw = atmoMilkyWay(rd);
  vec3 col = mw.rgb * 0.055;
  col += atmoStarLayer(rd, 70.0, 0.035, px, 2.6);                       // bright, sparse
  col += atmoStarLayer(rd, 190.0, 0.015 + 0.2 * min(mw.w, 1.5), px, 0.4); // faint, crowding into the Milky Way
  col *= vis;
  if (withSun) col += atmoSunDisc(rd, px);
  return col;
}

vec3 skyRadiance(vec3 p, vec3 dir) {
  vec3 L, T;
  float tg = raySphere(p, dir, PLANET_R).x;
  atmoMarch(p, dir, tg > 0.0 ? tg : 1e9, 0.5, uQuality == 0 ? 6 : 10, L, T);
  return L + T * (tg > 0.0 ? vec3(0.0) : spaceBackground(dir, false));
}
`;

// Fragment shader for the lookup tables: COMMON + ATMOSPHERE + this. Runs once; uses no uniforms.
export const TRANS_LUT_FS = /* glsl */ `
out vec4 outColor;

// transmittance from p toward dir, integrated inline (the table being built can't be sampled)
vec3 lutTrans(vec3 p, vec3 dir, int n) {
  if (raySphere(p, dir, PLANET_R - 400.0).x > 0.0) return vec3(0.0);   // softened planet edge for the terminator
  float t1 = raySphere(p, dir, ATMO_R).y;
  if (t1 <= 0.0) return vec3(1.0);
  float tm = clamp(-dot(p, dir), 0.0, t1), fn = float(n), tPrev = 0.0;
  vec3 od = vec3(0.0);
  for (int i = 0; i < 64; i++) {
    if (i >= n) break;
    float tNext = atmoWarp(float(i + 1) / fn, 0.0, t1, tm);
    float t = atmoWarp((float(i) + 0.5) / fn, 0.0, t1, tm);
    od += atmoExtinction(atmoDensity(max(length(p + dir * t) - PLANET_R, 0.0))) * (tNext - tPrev);
    tPrev = tNext;
  }
  // This planet is ~100x smaller than Earth, so a horizontal sun ray only crosses ~9 air masses instead of ~38 and
  // sunsets come out pale. Stretch the optical depth of near-horizontal sun paths toward Earth's air-mass curve.
  float mu = dot(p, dir) / length(p);
  return exp(-od * (1.0 + ATM_LOWSUN * (1.0 - smoothstep(-0.03, 0.12, mu))));
}

// Sky seen from altitude h with the sun at zenith cosine muS, integrated over the sphere of directions.
// amb: irradiance on an upward surface (/PI, in SUN_E units); psi: isotropic multiple-scattering radiance.
void lutSky(float h, float muS, out vec3 amb, out vec3 psi) {
  vec3 ro = vec3(0.0, PLANET_R + max(h, 2.0), 0.0);
  vec3 sd = vec3(sqrt(max(0.0, 1.0 - muS * muS)), muS, 0.0);
  vec3 Lall = vec3(0.0), Sall = vec3(0.0), Lup = vec3(0.0), Sup = vec3(0.0);
  const int D = 32, N = 10;
  for (int i = 0; i < D; i++) {
    float z = 1.0 - (2.0 * float(i) + 1.0) / float(D);
    float az = float(i) * 2.39996323;
    float rz = sqrt(max(0.0, 1.0 - z * z));
    vec3 dir = vec3(rz * cos(az), z, rz * sin(az));
    float mu = dot(dir, sd);
    float pR = phaseR(mu), pM = phaseM(mu);
    float tg = raySphere(ro, dir, PLANET_R).x;
    float tEnd = tg > 0.0 ? tg : raySphere(ro, dir, ATMO_R).y;
    float tm = clamp(-dot(ro, dir), 0.0, tEnd), tPrev = 0.0;
    vec3 L = vec3(0.0), S = vec3(0.0), T = vec3(1.0);
    for (int k = 0; k < N; k++) {
      float tNext = atmoWarp(float(k + 1) / float(N), 0.0, tEnd, tm);
      float t = atmoWarp((float(k) + 0.5) / float(N), 0.0, tEnd, tm);
      float dt = tNext - tPrev;
      tPrev = tNext;
      vec3 p = ro + dir * t;
      vec3 d = atmoDensity(max(length(p) - PLANET_R, 0.0));
      vec3 ext = atmoExtinction(d);
      vec3 sR = BETA_R * d.x;
      vec3 sM = BETA_M * d.y * ATM_MIE_TINT;
      vec3 stepT = exp(-ext * dt);
      vec3 w = T * (1.0 - stepT) / max(ext, vec3(1e-12));
      L += w * (sR * pR + sM * pM) * lutTrans(p, sd, 8);
      S += w * (sR + sM);
      T *= stepT;
    }
    L *= PI;
    if (tg > 0.0) {
      vec3 pg = ro + dir * tg, ng = normalize(pg);
      L += T * ATM_GROUND_ALB * lutTrans(pg, sd, 8) * max(dot(ng, sd), 0.0);
    }
    Lall += L; Sall += S;
    if (z > 0.0) { Lup += L * z; Sup += S * z; }
  }
  vec3 f = Sall / float(D);
  psi = (Lall / float(D)) / max(1.0 - f, vec3(0.05));
  amb = (Lup + psi * Sup) * (4.0 / float(D));
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  if (fc.y < ATM_REG_T.w) {
    vec2 uv = fc / ATM_REG_T.zw;
    float s = uv.x * 2.0 - 1.0;
    float mu = sign(s) * s * s;
    float h = uv.y * uv.y * (ATMO_R - PLANET_R);
    vec3 ro = vec3(0.0, PLANET_R + h, 0.0);
    vec3 rd = vec3(sqrt(max(0.0, 1.0 - mu * mu)), mu, 0.0);
    outColor = vec4(sqrt(lutTrans(ro, rd, 40)), 1.0);
  } else {
    bool isAmb = fc.x < ATM_REG_MS.x;
    vec2 uv = (fc - (isAmb ? ATM_REG_AMB.xy : ATM_REG_MS.xy)) / ATM_REG_AMB.zw;
    float s = uv.x * 2.0 - 1.0;
    float mu = sign(s) * s * s;
    float h = uv.y * uv.y * (ATMO_R - PLANET_R);
    vec3 amb, psi;
    lutSky(h, mu, amb, psi);
    outColor = vec4(sqrt(clamp((isAmb ? amb : psi) / ATM_SKY_SCALE, 0.0, 1.0)), 1.0);
  }
}
`;
