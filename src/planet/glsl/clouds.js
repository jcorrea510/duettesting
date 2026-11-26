// Clouds: a thin volumetric cloud layer around the planet, driven by a global weather map.
// OWNER: clouds agent.
//
// CONTRACT:
//   vec4  cloudLayer(vec3 ro, vec3 rd, float tMax)   premultiplied (rgb radiance * alpha, alpha) of clouds between ro and ro+rd*tMax
//   float cloudShadow(vec3 p)                        fraction of sunlight NOT blocked by clouds at surface point p, [0,1]
//   float cloudCoverage(vec3 dir)                    raw coverage [0,1] at a unit direction (used by other modules, e.g. ocean, audio hints)
// May call: sunTransmittance, sunLight, skyAmbient, noise3/noised3, raySphere, uTime.
//
// Layout: clouds live in a shell CLD_BOT..CLD_TOP (R+1800 .. R+4200). CLOUD_R (R+2600, common.js) is the
// reference height used by the far-field / shadow / coverage lookups (CLD_MID below).
//
// Pipeline:
//   cldWeather(dir)   planet-scale weather map: latitude climatology (ITCZ, dry subtropics, storm tracks),
//                     two spiral cyclones (domain-rotated noise around storm centres), zonal streak bands,
//                     fair-weather cumulus over land. Returns (coverage, convective height).
//   cldDensity(p,..)  3D density inside the shell: flat bases, domed tops, LOD'd fbm + billow erosion.
//   near path         short jittered raymarch through the part of the shell the ray crosses (adaptive step count),
//                     1-2 sun samples, Beer + powder + two-lobe phase + cheap multiple-scattering term.
//   far path          (camera far from the layer, i.e. orbit) one column lookup + a gradient self-shadow sample.
// Cost (uQuality 1): near <= 22 steps x (<=4 noise + 2x2 noise for light) + 2-3 weather maps (~7 noise each);
// far ~ 7 + 2x3 noise. uQuality 0: <= 10 steps, 1 light sample, fewer octaves.
export const CLOUDS = /* glsl */ `
const float CLD_BOT   = PLANET_R + 1800.0;
const float CLD_TOP   = PLANET_R + 4200.0;
const float CLD_MID   = CLOUD_R;                 // reference height for 2D lookups (R+2600)
const float CLD_THICK = CLD_TOP - CLD_BOT;
const float CLD_SIGMA = 0.0075;                  // extinction per metre at density 1
const float CLD_FREQ  = 1.0 / 1700.0;            // base noise frequency (cells ~ 1.5 km)
const float CLD_FAR0  = 24000.0, CLD_FAR1 = 42000.0;   // near -> far path blend (distance to the layer)

// storm centres (unit vectors; lat/lon in comments)
const vec3 CLD_STORM_A = vec3(-0.0668, 0.6428, 0.7631);   // lat 40N, lon -5 : northern cyclone (counter-clockwise)
const vec3 CLD_STORM_B = vec3( 0.6917, -0.2079, 0.6917);  // lat 12S, lon 45 : southern cyclone (clockwise)

float cldSq(float x) { return x * x; }

// approximate copy of terrain's continentField (2 of its 3 terms), for cumulus over land
float cldLand(vec3 d) {
  vec3 p = d * 2.2;
  float c = 0.6 * noise3(p) + 0.3 * noise3(M3 * p * 2.1 + vec3(3.1, 1.7, -2.3));
  return smoothstep(0.0, 0.3, c);
}

// storm geometry: rotates the texture coordinate q about the storm axis c (more near the centre, so the
// noise is sheared into spiral bands) and returns (distance / radius, azimuth) for the explicit spiral
vec3 cldStormGeo(vec3 d, vec3 c, float rad, float spin, vec3 q, out vec2 ap) {
  float ca = clamp(dot(d, c), -1.0, 1.0);
  float a = max(acos(ca), 1e-4);
  vec3 e1 = normalize(cross(c, vec3(0.0, 1.0, 0.0)));
  vec3 e2 = cross(c, e1);
  ap = vec2(a / rad, atan(dot(d, e2), dot(d, e1)));
  float th = -spin * (4.0 * exp(-a / (0.3 * rad)) + uTime * 0.004);
  float cs = cos(th), sn = sin(th), cq = dot(q, c);
  return q * cs + cross(c, q) * sn + c * (cq * (1.0 - cs));
}
// (influence, coverage) of a storm: two log-spiral arms wrapping into a dense core with a clear eye
vec2 cldStormCov(vec2 ap, float spin, float n) {
  float x = ap.x;
  float env = 1.0 - smoothstep(0.35, 1.0, x);
  float s = sin(2.0 * ap.y + spin * 4.2 * log(x) + 2.5 * n);
  float arms = smoothstep(-0.1, 0.6, s) * (1.0 - smoothstep(0.55, 1.0, x));
  float core = exp(-x / 0.16);
  float eye = smoothstep(0.03, 0.06, x);
  float wall = exp(-cldSq((x - 0.08) / 0.04));
  float cov = (0.3 + 0.9 * arms + 1.2 * core + 0.6 * wall) * eye;
  return vec2(env, cov);
}

// x: coverage [0,1], y: convective height factor [0,1] (0 flat/streaky stratocumulus, 1 towering)
vec2 cldWeather(vec3 d) {
  float sl = d.y, as = abs(sl);
  float itcz = exp(-cldSq((sl - 0.06) / 0.10));
  float subtrop = exp(-cldSq((as - 0.52) / 0.12));
  float track = exp(-cldSq((as - 0.80) / 0.12));
  vec2 apA, apB;
  vec3 q = cldStormGeo(d, CLD_STORM_A, 0.40, 1.0, d, apA);
  q = cldStormGeo(d, CLD_STORM_B, 0.32, -1.0, q, apB);
  q += vec3(-0.0011, 0.0, 0.0004) * uTime;
  // flow warp: push the texture along the iso-lines of a large noise -> filaments, sheared edges
  vec4 g = noised3(q * 2.2 + 5.3);
  q += cross(d, g.yzw) * 0.035;
  float n1 = 0.55 * noise3(q * 3.1) + 0.28 * noise3(M3 * q * 6.7 + 1.7) + 0.14 * noise3(M3 * M3 * q * 14.1 - 2.9);
  float bands = noise3(vec3(q.x * 4.5, q.y * 30.0 + 2.5 * n1, q.z * 4.5));
  float land = cldLand(d);
  float cov = 0.47 + 0.35 * itcz - 0.12 * subtrop + 0.18 * track + 1.3 * n1;
  cov += 0.75 * bands * (0.7 * subtrop + track + 0.4 * itcz);
  cov += land * 0.18 * (1.0 - as);
  // fronts: long meandering ridges of a warped noise, mostly in the mid-latitude storm tracks
  float fr = 1.0 - abs(noise3(q * 2.4 + vec3(7.7, 1.3, -4.1)));
  cov += 0.8 * smoothstep(0.82, 0.97, fr) * (0.35 + track + 0.5 * subtrop);
  vec2 sA = cldStormCov(apA, 1.0, n1), sB = cldStormCov(apB, -1.0, n1);
  cov = mix(cov, sA.y + 0.6 * n1, sA.x);
  cov = mix(cov, sB.y + 0.6 * n1, sB.x);
  float storm = max(sA.x * min(sA.y, 1.0), sB.x * min(sB.y, 1.0));
  float conv = 0.42 + 0.55 * itcz + 0.5 * land * (1.0 - as) + 0.6 * storm + 0.6 * n1;
  cov = smoothstep(0.18, 0.85, cov);
  // fair-weather cumulus floor: outside the eyes and the driest subtropical highs the sky is never empty
  float floorCov = (0.36 + 0.14 * land) * (1.0 - 0.6 * subtrop) * smoothstep(0.03, 0.06, min(apA.x, apB.x));
  cov = max(cov, floorCov);
  return vec2(cov, clamp(conv, 0.0, 1.0));
}

// fbm with a fractional octave count so LOD changes fade instead of pop; missing octaves keep the mean
float cldFbm(vec3 q, float lod) {
  float f = 0.0, a = 0.5;
  q = M3 * q;
  for (int i = 0; i < 4; i++) {
    float k = clamp(lod - float(i), 0.0, 1.0);
    if (k <= 0.0) break;
    f += a * k * noise3(q);
    q = M3 * q * 2.03;
    a *= 0.46;
  }
  return f;
}

vec3 cldWindOffset() { return vec3(-6.0, 0.0, 2.5) * CLD_FREQ * uTime; }

// signed density at world point p (> 0 inside cloud; values below 0 say how far from the surface we are).
// w = weather, se = streak axis * stretch amount (per ray), lod = base octaves (fractional),
// ero = detail erosion weight (0 when far / cheap lookups)
float cldDensityRaw(vec3 p, vec2 w, vec3 se, float lod, float ero, float sharp) {
  float h = (length(p) - CLD_BOT) / CLD_THICK;
  float top = mix(0.25, 1.0, w.y) * (0.5 + 0.5 * w.x);
  if (h <= 0.0 || h >= top || w.x < 0.02) return -1.0;
  float hn = h / top;
  vec3 q = p * CLD_FREQ + cldWindOffset();
  q -= se * dot(q, se);                       // compress along the wind: cloud streets / streaks
  float n = 0.5 + cldFbm(q, lod);
  float thr = 1.0 - w.x + 0.95 * hn * hn + 0.2 * (1.0 - smoothstep(0.0, 0.12, hn));
  float d = (n - thr) * sharp;
  if (d > -0.05 && ero > 0.0) {
    float b = 1.0 - abs(noise3(q * 9.3 + vec3(1.3, 7.1, 2.9)));   // billows
    d -= ero * 0.4 * b * (1.0 - clamp(d, 0.0, 1.0)) * (0.6 + 0.6 * hn);
  }
  return d * smoothstep(0.0, 0.04, h);
}
float cldDensity(vec3 p, vec2 w, vec3 se, float lod, float ero, float sharp) {
  return clamp(cldDensityRaw(p, w, se, lod, ero, sharp), 0.0, 1.0);
}

// 2D column fraction at reference height (far path, shadows, coverage)
float cldColumn(vec3 p, vec2 w, float lod) {
  vec3 q = p * CLD_FREQ + cldWindOffset();
  float n = 0.5 + 0.75 * cldFbm(q, lod);
  return clamp((n - (1.0 - w.x) + 0.04) * 1.25, 0.0, 1.0);
}

float cldHG(float mu, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5));
}
float cldPhase(float mu) { return mix(cldHG(mu, -0.2), cldHG(mu, 0.72), 0.65); }

vec4 cldNear(vec3 ro, vec3 rd, float t0, float t1, float pa) {
  float tEnd = min(t1, t0 + 30000.0);
  float len = tEnd - t0;
  vec3 pA = ro + rd * t0, pB = ro + rd * tEnd, pM = ro + rd * (t0 + 0.5 * len);
  vec2 wA = cldWeather(normalize(pA));
  vec2 wB = cldWeather(normalize(pB));
  vec2 wM = len > 7000.0 ? cldWeather(normalize(pM)) : 0.5 * (wA + wB);
  if (max(max(wA.x, wB.x), wM.x) < 0.03) return vec4(0.0);

  // two-speed march: coarse cheap steps through empty space, fine lit steps once near/inside cloud
  int nFine = uQuality == 0 ? 12 : (uQuality == 1 ? 28 : 64);
  int nIter = nFine + (uQuality == 0 ? 20 : 36);
  float dtC = max(len / 20.0, 220.0 + 0.016 * t0);
  float dtF = 0.0;
  float j = hash2(ivec2(gl_FragCoord.xy) + ivec2(int(uTime * 61.0) * 13, 77));

  vec3 upM = normalize(pM);
  vec3 east = normalize(cross(vec3(0.0, 1.0, 0.0), upM) + vec3(1e-4, 0.0, 0.0));
  vec3 se = east * (0.62 * (1.0 - 0.5 * (wA.y + wB.y)));
  vec3 amb = skyAmbient(pM, upM) * 1.6;
  float mu = dot(rd, uSunDir);
  float ph = cldPhase(mu);
  float sunUp = dot(upM, uSunDir);
  vec3 bounce = vec3(0.30, 0.32, 0.30) * SUN_E * 0.025 * max(sunUp, 0.0);
  bool twoLight = uQuality > 0;

  float T = 1.0;
  vec3 S = vec3(0.0);
  float t = t0 + j * dtC;
  bool fine = false;
  int fineUsed = 0, empty = 0;
  float tBack = t0;                // never step back before this (avoids re-marching what fine steps covered)
  for (int i = 0; i < 80; i++) {
    if (i >= nIter || t >= tEnd || T < 0.015 || fineUsed >= nFine) break;
    vec3 p = ro + rd * t;
    float f = (t - t0) / len;
    vec2 w = f < 0.5 ? mix(wA, wM, f * 2.0) : mix(wM, wB, f * 2.0 - 1.0);
    if (!fine) {
      // cheap probe, used like a distance bound: the further below 0, the bigger the safe step
      float dc = cldDensityRaw(p, w, se, 2.0, 0.0, 2.6);
      if (dc > -0.32 && fineUsed < nFine) { fine = true; empty = 0; t = max(t - (40.0 + 0.03 * t) * 1.5, tBack); continue; }
      float dtp = clamp((-dc - 0.25) * 900.0, 60.0 + 0.012 * t, dtC);
      if (dc > 0.0) {
        // fine budget used up: keep going with the probe density and an unshadowed estimate (no holes)
        dtp = min(150.0 + 0.03 * t, tEnd - t);
        float dd = min(dc, 1.0);
        float h = clamp((length(p) - CLD_BOT) / CLD_THICK, 0.0, 1.0);
        vec3 Lc = sunLight(p) * (ph * 2.0 + 0.62 * 0.45 * mix(0.55, 1.0, h)) + amb * mix(0.45, 1.25, h);
        float Ts = exp(-dd * CLD_SIGMA * dtp);
        S += T * Lc * (1.0 - Ts);
        T *= Ts;
      }
      t += dtp;
      continue;
    }
    fineUsed++;
    float fp = t * pa;                                      // pixel footprint, metres
    float lod = clamp(3.9 - log2(max(fp, 1.0) / 40.0), 1.5, uQuality == 0 ? 2.5 : 4.0);
    float ero = uQuality == 0 ? 0.0 : 1.0 - smoothstep(50.0, 220.0, fp);
    // fine step: small near the camera, growing with distance and as the budget gets used up
    float dtc = min((40.0 + 0.02 * t) * (1.0 + 2.0 * cldSq(float(fineUsed) / float(nFine))), tEnd - t);
    float sharp = mix(2.6, 1.2, smoothstep(3000.0, 18000.0, t));   // softer, less aliased edges far away
    float d = cldDensity(p, w, se, lod, ero, sharp);
    if (d > 0.002) {
      empty = 0;
      // light: one or two samples toward the sun
      float od = cldDensity(p + uSunDir * 160.0, w, se, min(lod, 2.0), 0.0, sharp) * 200.0;
      if (twoLight && fp < 120.0) od += cldDensity(p + uSunDir * 560.0, w, se, 1.5, 0.0, sharp) * 520.0;
      else od *= 2.8;
      od = (od + d * 60.0) * CLD_SIGMA;
      float h = clamp((length(p) - CLD_BOT) / CLD_THICK, 0.0, 1.0);
      vec3 sunC = sunLight(p);
      // single scattering (phase-shaped, gives silver linings) + a cheap multiple-scattering lobe
      float ms = 0.7 * exp(-od * 0.35) + 0.3 * exp(-od * 0.1);
      float powder = 1.0 - 0.45 * exp(-d * 4.0 - od * 1.5);
      powder = mix(powder, 1.0, 0.5 + 0.5 * mu);
      vec3 Ls = sunC * (ph * 6.0 * exp(-od) + (0.62 + 1.2 * ph) * ms * mix(0.55, 1.0, h)) * powder;
      vec3 La = amb * mix(0.45, 1.25, h) + bounce * (1.0 - h);
      vec3 Lc = (Ls + La) * 0.96;
      float Ts = exp(-d * CLD_SIGMA * dtc);
      S += T * Lc * (1.0 - Ts);
      T *= Ts;
    } else if (++empty >= 3) {
      fine = false;
      tBack = t + dtc;
    }
    t += dtc;
  }
  return vec4(S, 1.0 - T);
}

vec4 cldFar(vec3 ro, vec3 rd, float tMax, float pa) {
  vec2 sm = raySphere(ro, rd, CLD_MID);
  float tm = sm.x > 0.0 ? sm.x : max(-dot(ro, rd), 0.0);
  if (tm > tMax) return vec4(0.0);
  vec3 p = ro + rd * tm;
  vec3 up = normalize(p);
  vec2 w = cldWeather(up);
  float lod = clamp(4.0 - log2(max(tm * pa, 1.0) / 60.0), 2.0, 3.0);
  float c = cldColumn(p, w, lod);
  if (sm.x <= 0.0) c *= smoothstep(CLD_TOP, CLD_MID, length(p));   // grazing above the mid height
  if (c <= 0.001) return vec4(0.0);
  float thick = CLD_THICK * mix(0.25, 1.0, w.y) * (0.5 + 0.5 * w.x) * (0.35 + 0.65 * c);
  float cv = abs(dot(up, rd));
  float od = CLD_SIGMA * 0.5 * c * c * thick / max(cv, 0.06);
  float a = 1.0 - exp(-od);
  // self shadow from the column toward the sun (gradient trick), and Beer through the slant thickness
  float c2 = cldColumn(p + uSunDir * 900.0, w, min(lod, 2.0));
  float sunUp = dot(up, uSunDir);
  float lit = clamp(1.0 - 1.4 * (c2 - c), 0.25, 1.0);
  float slant = exp(-CLD_SIGMA * 0.06 * c * thick / max(sunUp + 0.05, 0.05));
  vec3 sunC = sunLight(p);
  float mu = dot(rd, uSunDir);
  vec3 Ls = sunC * (0.45 * smoothstep(-0.1, 0.6, sunUp) + cldPhase(mu) * 0.9 * (1.0 - a * 0.6)) * lit * (0.35 + 0.65 * slant) * (0.6 + 0.4 * c);
  vec3 La = skyAmbient(p, up) * 1.3;
  return vec4((Ls + La) * a, a);
}

vec4 cloudLayer(vec3 ro, vec3 rd, float tMax) {
  vec2 sT = raySphere(ro, rd, CLD_TOP);
  if (sT.y <= 0.0) return vec4(0.0);
  vec2 sB = raySphere(ro, rd, CLD_BOT);
  float r0 = length(ro);
  float t0, t1;
  if (r0 >= CLD_TOP)      { t0 = sT.x; t1 = sB.x > 0.0 ? sB.x : sT.y; }
  else if (r0 >= CLD_BOT) { t0 = 0.0;  t1 = sB.x > 0.0 ? sB.x : sT.y; }
  else                    { t0 = sB.y; t1 = sT.y; }
  t1 = min(t1, tMax);
  if (t1 <= t0) return vec4(0.0);
  float pa = 2.0 / (uFocal * uRes.y);
  float fw = smoothstep(CLD_FAR0, CLD_FAR1, t0);
  vec4 cn = vec4(0.0), cf = vec4(0.0);
  if (fw < 1.0) cn = cldNear(ro, rd, t0, t1, pa);
  if (fw > 0.0) cf = cldFar(ro, rd, tMax, pa);
  return mix(cn, cf, fw);
}

float cloudShadow(vec3 p) {
  vec2 s = raySphere(p, uSunDir, CLD_MID);
  if (s.y <= 0.0) return 1.0;
  vec3 q = p + uSunDir * s.y;
  vec3 up = normalize(q);
  vec2 w = cldWeather(up);
  float c = cldColumn(q, w, uQuality == 0 ? 1.5 : 2.2);
  float thick = CLD_THICK * mix(0.25, 1.0, w.y) * (0.5 + 0.5 * w.x) * (0.35 + 0.65 * c);
  float od = CLD_SIGMA * 0.35 * c * thick;
  return mix(1.0, 0.1, 1.0 - exp(-od));
}

float cloudCoverage(vec3 dir) {
  vec2 w = cldWeather(dir);
  return cldColumn(dir * CLD_MID, w, 2.0);
}
`;
