// Ocean: the sea-level sphere.
// OWNER: ocean agent.
//
// CONTRACT:
//   vec3 shadeOcean(vec3 p, vec3 rd, float t)    lit water radiance at sea-surface point p (before atmosphere along the view ray)
// May call: terrainHeight (water depth), seabedAlbedo, sunLight, skyAmbient, skyRadiance, cloudShadow, cloudLayer, noise helpers.
//
// How it works (all normals, no displacement):
//  * Waves: a sum of directional sharpened-sine waves, long swell to short chop (4 / 8 / 12 waves by uQuality), plus
//    1-2 octaves of moving value-noise ripples. Wave vectors are integer multiples of 2*pi/OCN_L in WORLD space, so the
//    phase can be taken from mod(p, OCN_L): exact in float even 60 km from the origin, and fixed to the world (no
//    swimming when the camera moves).
//  * Anti-aliasing: every wave is faded out as its wavelength approaches the pixel footprint, and the slope variance it
//    carried moves into the GGX roughness instead. So the sun glint is the same "energy" at every distance: sparkling
//    glitter up close, a soft glowing patch from orbit, never noisy.
//  * Colour: Fresnel (roughness-aware) between the reflected sky and the water body. The body is a depth-dependent
//    mix of deep navy and the lit sea bed seen through an absorbing water column (red dies first -> turquoise shallows).
//  * Surf: foam lines that follow the depth contours and travel shoreward, a swash line at the water's edge, sparse
//    whitecaps on wave crests, and backlit subsurface glow in crests.
//  * Night: sky reflection (stars via skyRadiance) and a moon glint / sheen. If common.js defines MOON_DIR (a unit
//    vec3 expression) it is used, otherwise the moon is placed opposite the sun.

// ---- wave table, built once in JS and baked into the shader as constants ----
const OCN_L = 2048;                         // world tile (m) the wave vectors are periodic over (power of two: exact mod)
const WIND = (() => {
  // waves travel toward heading ~30 deg at the landing beach (lat 22.03, lon 17.70): onshore there
  const d = Math.PI / 180, lat = 22.0344 * d, lon = 17.6996 * d;
  const g = [Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon)];
  let e = [g[2], 0, -g[0]]; const el = Math.hypot(...e); e = e.map((x) => x / el);
  const n = [g[1] * e[2] - g[2] * e[1], g[2] * e[0] - g[0] * e[2], g[0] * e[1] - g[1] * e[0]];
  const h = 30 * d;
  const w = [0, 1, 2].map((i) => n[i] * Math.cos(h) + e[i] * Math.sin(h));
  const p = [0, 1, 2].map((i) => -n[i] * Math.sin(h) + e[i] * Math.cos(h));
  return { w, p };
})();
const LAMBDA = [172, 104, 61, 41, 27.5, 19, 13.1, 8.9, 6.1, 4.15, 2.83, 1.93, 1.31, 0.89];
const ANGLE = [-0.12, 0.38, 0.0, 0.42, -0.31, 0.71, -0.18, 0.95, -0.62, 0.15, 1.2, -0.85, 0.4, -1.3];
const STEEP = [0.022, 0.027, 0.032, 0.036, 0.04, 0.044, 0.048, 0.052, 0.052, 0.056, 0.056, 0.056, 0.052, 0.048];
const PHASE = [0.88, 0.31, 0.13, 0.71, 0.42, 0.95, 0.27, 0.58, 0.04, 0.83, 0.36, 0.67, 0.19, 0.5];
const f = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(+x.toPrecision(9)));
const K = [], AMP = [], FREQ = [], VAR = [];
for (let i = 0; i < LAMBDA.length; i++) {
  const a = ANGLE[i];
  const dir = [0, 1, 2].map((j) => WIND.w[j] * Math.cos(a) + WIND.p[j] * Math.sin(a));
  const nI = dir.map((x) => Math.round(x * OCN_L / LAMBDA[i]));
  const k = nI.map((x) => x * 2 * Math.PI / OCN_L);
  const km = Math.hypot(...k);
  K.push(`vec3(${k.map(f).join(', ')})`);
  AMP.push(f(STEEP[i] / km));
  FREQ.push(f(Math.sqrt(9.81 * km) / (2 * Math.PI)));    // deep-water dispersion, cycles per second
  VAR.push(STEEP[i] * STEEP[i] * 0.625);                   // mean-square slope of the sharpened sine
}
// micro ripples (noise) + capillaries below the smallest wave: always part of the roughness budget
const RIPPLE_VAR = 0.004, FLOOR_VAR = 0.002;
const VAR_TOTAL = VAR.reduce((s, v) => s + v, 0) + RIPPLE_VAR + FLOOR_VAR;

export const OCEAN = /* glsl */ `
const float OCN_L = ${f(OCN_L)};
const vec3  OCN_K[14]   = vec3[14](${K.join(', ')});
const float OCN_AMP[14] = float[14](${AMP.join(', ')});
const float OCN_FRQ[14] = float[14](${FREQ.join(', ')});
const float OCN_PH[14]  = float[14](${PHASE.map(f).join(', ')});
const float OCN_LAM[14] = float[14](${LAMBDA.map(f).join(', ')});
const float OCN_VAR[14] = float[14](${VAR.map(f).join(', ')});
const float OCN_VAR_RIPPLE = ${f(RIPPLE_VAR)};
const float OCN_VAR_FLOOR  = ${f(FLOOR_VAR)};
const float OCN_VAR_TOTAL  = ${f(VAR_TOTAL)};
const vec3  OCN_WIND = vec3(${WIND.w.map(f).join(', ')});

vec3 ocnMoonDir() {
#ifdef MOON_DIR
  return MOON_DIR;
#else
  return normalize(-uSunDir + vec3(0.0, 0.18, 0.0));
#endif
}

// GGX alpha^2 from the slope variance the pixel cannot resolve. Far away only part of it is used (0.2 from orbit), which
// keeps the distant glint compact and bright, with slicks
// (a calm-sea look); the floor stands for capillaries; + the sun disc's angular size.
float ocnRough(float unresolvedVar, float fp) {
  return max(unresolvedVar * mix(0.7, 0.2, smoothstep(30.0, 300.0, fp)), OCN_VAR_FLOOR * 2.2) + 0.0003;
}

float ocnGGX(float nh, float a2) {
  float d = nh * nh * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}
// height-correlated Smith visibility term (includes the 1/(4 nl nv))
float ocnVis(float nv, float nl, float a2) {
  float gv = nl * sqrt(nv * nv * (1.0 - a2) + a2);
  float gl = nv * sqrt(nl * nl * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-5);
}
// specular from a small bright light (sun / moon) of irradiance E in direction l
vec3 ocnSpec(vec3 n, vec3 v, vec3 l, vec3 E, float a2) {
  float nl = dot(n, l);
  if (nl <= 0.0) return vec3(0.0);
  vec3 h = normalize(l + v);
  float nv = max(dot(n, v), 1e-3);
  float vh = max(dot(v, h), 0.0);
  float F = 0.02 + 0.98 * pow(1.0 - vh, 5.0);
  // two lobes: a sharp core (calm patches, slicks) and a 5x broader halo (the rough tail of the slope distribution)
  float nh = max(dot(n, h), 0.0);
  float D = mix(ocnGGX(nh, a2), ocnGGX(nh, a2 * 5.0), 0.4);
  // x PI: the rest of the renderer treats albedo * E as radiance (no 1/PI), so the BRDF is scaled to match
  return E * (PI * nl * D * ocnVis(nv, nl, a2 * 2.0) * F);
}

// cheap sky for uQuality 0: average sky radiance from skyAmbient, brighter and paler toward the horizon, warm toward the sun
vec3 ocnSkyCheap(vec3 p, vec3 up, vec3 r) {
  vec3 amb = skyAmbient(p, up);   // skyAmbient is already average sky radiance in this convention
  float mu = clamp(dot(r, up), 0.0, 1.0);
  float lum = dot(amb, vec3(0.3, 0.5, 0.2));
  vec3 hor = mix(amb, vec3(lum), 0.45) * 1.7;
  vec3 col = mix(hor, amb * 0.85, pow(mu, 0.45));
  col += sunLight(p) * 0.012 * pow(max(dot(r, uSunDir), 0.0), 6.0);
  return col;
}

// wave normal: returns normal; out roughness^2 (unresolved slope variance) and crest measure [0,1]
// sea: local sea state (wind patches x shoaling), scales every amplitude
vec3 ocnWaves(vec3 p, vec3 up, float fp, float sea, out float a2, out float crest) {
  int nW = uQuality == 0 ? 5 : (uQuality == 1 ? 9 : 14);
  vec3 mp = mod(p, OCN_L);                             // exact for a power-of-two L: keeps the phase precise
  vec3 grad = vec3(0.0);
  float varRes = 0.0, cr = 0.0, wsum = 0.0;
  float group = 1.0, warpL = 0.0, warpS = 0.0;
  if (uQuality > 0 && fp < 60.0) {
    // wave groups: the long swell comes in sets, so its amplitude swells and fades across a few hundred metres
    group = 0.62 + 0.5 * noise3(p * (1.0 / 380.0) - OCN_WIND * (uTime * 0.004));
    // an irregular swell component (noise, ~100 m); its value also bends every crest line (phase warp)
    vec4 sw = noised3(M3 * ((p - OCN_WIND * (uTime * 2.0)) * (1.0 / 95.0)));
    grad += (0.014 * smoothstep(60.0, 20.0, fp) * sea) * (sw.yzw * M3);   // ~1.3 m of height over 95 m
    warpL = sw.x * 1.8;
  }
  // random chop (two rotated noise octaves, ~20 m and ~8 m); the first also warps the short waves' crests
  if (uQuality > 0) {
    float fr = 1.0 / 20.0;
    float hgt = 0.16 * sea;
    for (int j = 0; j < 2; j++) {
      float w = smoothstep(1.2, 3.2, (1.0 / fr) / fp);
      if (w <= 0.0) break;
      vec4 nz = noised3(M3 * ((p - OCN_WIND * (uTime * (1.2 - 0.5 * float(j)))) * fr) + float(j) * 17.3);
      grad += (hgt * w * fr) * (nz.yzw * M3);
      if (j == 0) warpS = nz.x * 1.4;
      fr *= 2.5; hgt *= 0.4;
    }
  }
  for (int i = 0; i < 14; i++) {
    if (i >= nW) break;
    float w = smoothstep(1.2, 3.2, OCN_LAM[i] / fp);
    if (w <= 0.0) break;                                // sorted long -> short: the rest are unresolved too
    // phase warp (its own slope is small next to k and is left out of the gradient)
    float sg = (i & 1) == 0 ? 1.0 : -0.85;
    float warp = sg * (warpL + (i >= 6 ? warpS : 0.0));
    float ph = 6.2831853 * fract(dot(mp, OCN_K[i]) * 0.15915494 - OCN_FRQ[i] * uTime + OCN_PH[i]) + warp;
    float s = sin(ph), c = cos(ph);
    float u = 0.5 + 0.5 * s;                            // height = A (2u^2 - 1): sharp crests, flat troughs
    float A = OCN_AMP[i] * w * sea * (i < 4 ? group : 1.0);
    grad += (A * 2.0 * u * c) * OCN_K[i];
    cr += OCN_AMP[i] * w * u * u;
    wsum += OCN_AMP[i] * w;
    varRes += w * w * OCN_VAR[i] * sea * sea;
  }
  // moving ripples (value noise with analytic gradient, rotated lattice so its grid never lines up with the sea)
  if (uQuality > 0) {
    float fr = 1.6;
    float amp = 0.03 / fr;
    vec3 drift = OCN_WIND * (uTime * 0.6);
    for (int j = 0; j < 2; j++) {
      if (j == 1 && uQuality < 2) break;
      float w = smoothstep(1.2, 3.2, (1.0 / fr) / fp);
      if (w <= 0.0) break;
      vec4 nz = noised3(M3 * ((p - drift) * fr) + vec3(0.0, uTime * 0.35, 0.0));
      grad += (amp * w * fr * sea) * (nz.yzw * M3);
      varRes += w * w * OCN_VAR_RIPPLE * 0.5 * sea * sea;
      fr *= 2.3; amp *= 0.55 / 2.3; drift *= 0.7;
    }
  }
  grad -= up * dot(grad, up);
  a2 = ocnRough(max(OCN_VAR_TOTAL * sea * sea - varRes, 0.0), fp);
  crest = wsum > 0.0 ? cr / wsum : 0.25;
  return normalize(up - grad);
}

// surf: foam bands that follow the depth contours and run up the beach, plus the swash edge
float ocnSurf(vec3 p, float depth, float fp) {
  if (depth > 7.0) return 0.0;
  float n1 = noise3(p * 0.035);
  float zone = smoothstep(7.0, 1.5, depth);
  // breakers: phase rises as depth falls, so the bands move toward the shore with time
  float ph = depth * 0.42 + uTime * 0.11 + n1 * 0.45;
  float b = fract(ph);
  float band = smoothstep(0.0, 0.05, b) * (1.0 - smoothstep(0.05, 0.45, b));   // sharp front, streaky tail
  float tex = 0.0;
  if (uQuality > 0) tex = noise3(p * vec3(0.55, 0.9, 0.55) + vec3(uTime * 0.2)) * 0.5 + noise3(p * 2.1) * 0.25;
  float lines = clamp(band * (0.75 + tex) * (0.6 + 0.4 * n1), 0.0, 1.0);
  float detail = smoothstep(6.0, 1.2, fp);              // bands too fine for the pixel -> their average
  float surf = zone * mix(0.22, lines, detail);
  // swash: the edge of the water pulses up and down the sand
  float edge = depth + 0.25 * sin(uTime * 0.55 + n1 * 4.0);
  float swash = smoothstep(0.7, 0.05, edge) * (0.55 + 0.45 * tex);
  return clamp(max(surf, swash), 0.0, 1.0);
}

vec3 shadeOcean(vec3 p, vec3 rd, float t) {
  vec3 up = normalize(p);
  vec3 v = -rd;
  float ndv0 = max(dot(up, v), 1e-3);

  // water depth: more octaves up close (the shoreline foam must sit on the visible waterline), few from far away
  int oct = clamp(int(10.0 - log2(1.0 + t / 250.0) * 1.6), 3, uQuality == 0 ? 5 : 9);
  float depth = max(-terrainHeight(up, oct), 0.0);

  // pixel footprint on the water (m), stretched toward grazing angles
  float fp = t * 2.0 / (uFocal * uRes.y) / pow(max(ndv0, 0.06), 0.75);

  // sea state: wind patches and slicks (km scale, drifting), wave groups (100 m scale), calmer over the shallows
  float wind = noise3(p * (1.0 / 2600.0) + vec3(uTime * 0.002, 0.0, 0.0)) * 0.7;
  if (uQuality > 0) wind += noise3(p * (1.0 / 160.0) + vec3(0.0, uTime * 0.01, 0.0)) * 0.3;
  float sea = mix(0.5, 1.35, smoothstep(-0.55, 0.45, wind)) * mix(0.35, 1.0, smoothstep(0.0, 5.0, depth));
  float a2, crest;
  vec3 n = up;
  if (fp < OCN_LAM[0] / 1.2) n = ocnWaves(p, up, fp, sea, a2, crest);
  else { a2 = ocnRough(OCN_VAR_TOTAL * sea * sea, fp); crest = 0.25; }
  // never show back-facing micro normals at grazing angles
  float nv = dot(n, v);
  if (nv < 0.02) { n = normalize(n + v * (0.02 - nv)); nv = 0.02; }

  // light
  float cs = cloudShadow(p);
  vec3 sunE = sunLight(p) * cs;
  vec3 moonDir = ocnMoonDir();
  float moonUp = dot(up, moonDir);
  vec3 moonE = SUN_E * vec3(0.0026, 0.003, 0.0038) * smoothstep(-0.02, 0.2, moonUp)
             * (1.0 - smoothstep(-0.12, 0.05, dot(up, uSunDir)));      // moonlight only matters once the sun is down
  vec3 amb = skyAmbient(p, up);

  // reflected sky (with Fresnel that falls at grazing angles when the surface is rough)
  vec3 r = reflect(rd, n);
  r = normalize(r + up * max(0.03 - dot(r, up), 0.0));
  vec3 sky;
  if (uQuality == 0) sky = ocnSkyCheap(p, up, r);
  else {
    sky = skyRadiance(p + up * 2.0, r);
    if (t < 40000.0) {
      vec4 cl = cloudLayer(p + up * 2.0, r, 1e9);
      sky = sky * (1.0 - cl.a) + cl.rgb;
    }
  }
  sky += SUN_E * vec3(0.0010, 0.0013, 0.0022) * (1.0 - smoothstep(-0.15, 0.1, dot(up, uSunDir))); // night airglow sheen
  float rough = sqrt(a2);
  float F = 0.02 + (max(1.0 - 1.6 * rough, 0.02) - 0.02) * pow(1.0 - nv, 5.0);

  // water body: deep navy <-> lit sea bed through an absorbing column (red goes first: turquoise shallows)
  float cosT = sqrt(1.0 - (1.0 - nv * nv) / 1.777);   // refracted view angle
  float path = depth * (1.0 + 1.0 / max(cosT, 0.2));
  vec3 Tr = exp(-vec3(0.40, 0.062, 0.048) * path);
  vec3 deep = vec3(0.0035, 0.014, 0.032);
  vec3 bodyAlb = mix(deep, seabedAlbedo(up) * 0.6, Tr);
  vec3 Ein = sunE * max(dot(up, uSunDir), 0.0) * 0.97 + amb + moonE * max(moonUp, 0.0);
  vec3 body = bodyAlb * Ein;

  // subsurface: light through thin crests, strongest looking toward a low sun
  float back = pow(max(dot(rd, uSunDir), 0.0), 3.0);
  float crestH = smoothstep(0.35, 0.9, crest);
  vec3 sssCol = vec3(0.05, 0.36, 0.30) * mix(vec3(1.0), Tr * 2.0 + 0.4, 0.5);
  body += sunE * sssCol * crestH * (0.012 + 0.06 * back) * max(dot(up, uSunDir) + 0.15, 0.0);

  vec3 col = body * (1.0 - F) + sky * F;
  vec3 spec = ocnSpec(n, v, uSunDir, sunE, a2) + ocnSpec(n, v, moonDir, moonE, a2 + 0.002);
  col += min(spec, SUN_E * 60.0);

  // foam: surf, swash and sparse whitecaps on crests
  float foam = ocnSurf(p, depth, fp);
  if (uQuality > 0) {
    float wc = smoothstep(0.86, 0.98, crest) * smoothstep(0.15, 0.6, noise3(p * 0.09 + vec3(0.0, uTime * 0.05, 0.0)));
    foam = max(foam, mix(0.012, wc * 0.8, smoothstep(6.0, 1.0, fp)));
  }
  vec3 foamCol = vec3(0.82, 0.86, 0.88) * (sunE * max(dot(n, uSunDir), 0.0) + amb + moonE * max(moonUp, 0.0));
  col = mix(col, foamCol, foam);
  return col;
}
`;
