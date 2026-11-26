// Terrain: the shape of the land, its materials and how it is lit.
// OWNER: terrain agent. Any change to terrainHeight MUST be mirrored exactly in ../terrain-cpu.js
// (the camera uses the JS copy to fly over the ground and pick landing spots).
//
// CONTRACT:
//   float terrainHeight(vec3 dir, int oct)          metres above sea level at unit direction dir (can be negative: sea floor)
//   float traceTerrain(vec3 ro, vec3 rd, float tMax, int steps)   distance to the first land hit, or -1
//   vec3  terrainNormal(vec3 p, float t)            world-space surface normal at surface point p seen from distance t
//   vec3  shadeTerrain(vec3 p, vec3 n, vec3 rd, float t)          lit surface radiance (before atmosphere)
//   vec3  seabedAlbedo(vec3 dir)                    colour of the sea floor (used by the ocean)
// May call: sunLight, sunTransmittance, skyAmbient, cloudShadow, noise helpers, raySphere.
//
// Shape = macro field (continents, plate boundaries, coasts: 8 noise lookups, no LOD, identical everywhere)
//       + detail (one loop of `oct` noise octaves feeding two sums: eroded hills and ridged mountains).
// The macro field also gives a cheap upper bound of the height, which lets the ray march skip the detail
// loop while it is well above the ground (most steps of most rays).
export const TERRAIN = /* glsl */ `
const float TER_SEA = 0.12;
const float TER_SOFTW = 200.0, TER_SOFT0 = HMAX - 20.0 - TER_SOFTW;   // tallest summits ease in below HMAX
const float TER_HILLMAX = 1.75, TER_MTNMAX = 1.15;  // practical maxima of the two detail sums (measured 1.61, 0.93)

struct TerMacro { float c, coast, land, belt, rng, cliff, base, hillAmp, mtnAmp, volc; };

TerMacro terrainMacro(vec3 d) {
  TerMacro M;
  vec3 p = d * 2.2;
  vec4 n0 = noised3(p);
  vec3 w = p + n0.yzw * 0.12;                        // warp by the first octave's slope
  vec3 a = M3 * w;
  vec3 b = M3 * a;
  float c = 0.6 * n0.x + 0.3 * noise3(a * 2.1 + vec3(3.1, 1.7, -2.3)) + 0.1 * noise3(b * 4.3);
  vec3 e = (M3 * b) * 9.1 + vec3(-5.3, 2.9, 1.3);
  c += 0.11 * noise3(e) + 0.05 * noise3((M3 * e) * 2.13 + vec3(1.7, -4.1, 0.6));
  c += 0.45 * smoothstep(0.8, 0.95, abs(d.y) + 0.06 * n0.x);   // polar land under the ice caps
  // tectonics: plate boundaries are the zero lines of a low-frequency noise; they push up ranges on land
  // and broken island arcs at sea
  vec3 tp = (M3 * d) * 3.3 + (vec3(7.3, -1.1, 4.9) + n0.yzw * 0.05);
  float belt = 1.0 - smoothstep(0.0, 0.36, abs(noise3(tp)));
  float rng = smoothstep(-0.3, 0.5, noise3(d * 6.3 + vec3(-2.2, 8.4, 3.3)));
  float spot = noise3((M3 * (M3 * d)) * 12.5 + vec3(4.4, -6.6, 2.2));
  float belt2 = belt * belt * rng;
  c += 0.42 * belt2 * smoothstep(-0.2, 0.5, spot + 0.5 * rng - 0.25);
  float coast = c - TER_SEA;
  float land = smoothstep(0.0, 0.25, coast);
  float cliff = smoothstep(0.0, 0.45, spot) * (0.4 + 0.6 * rng);
  // sea floor: shallow shelf, then the deep
  float sea = -6.0 - 70.0 * smoothstep(0.0, 0.06, -coast) - 460.0 * smoothstep(0.05, 0.35, -coast);
  // land: beaches or cliffs at the shore, plains rising to interior uplands
  float cw = mix(0.02, 0.0025, cliff);
  float landH = 2.5 + 75.0 * cliff + 280.0 * smoothstep(0.0, 0.5, coast);
  float base = mix(sea, landH, smoothstep(-0.3 * cw, cw, coast));
  // volcanic island arcs where plate boundaries run through the sea
  float volc = belt2 * smoothstep(0.15, 0.75, spot);
  base += 330.0 * volc * (1.0 - land) * smoothstep(0.0, 0.08, -coast);
  // mountains: the plate-boundary ranges, plus massifs scattered through the interiors
  float mtn = max(belt2, smoothstep(0.3, 0.9, rng) * smoothstep(-0.5, 0.2, spot));
  float mland = smoothstep(-0.03, 0.12, coast);
  base += 120.0 * mtn * mland;
  M.mtnAmp = 1150.0 * mtn * mland + 330.0 * volc * (1.0 - land) + 40.0 * land;
  M.hillAmp = 14.0 * smoothstep(-0.12, -0.02, coast) + 100.0 * land;   // no detail on the open sea floor: rays skip it
  M.c = c; M.coast = coast; M.land = land; M.belt = belt; M.rng = rng; M.cliff = cliff; M.base = base; M.volc = volc;
  return M;
}

// One octave loop, two sums.  x = hills: eroded fbm (each octave damped by the slope accumulated so far:
// smooth valleys, rough crests), about -1.4..1.6.  y = mountains: more weight in the fine octaves, lighter damping,
// and octaves 1-4 sharpened toward ridged noise (knife-edge crests, branching gullies), about -1.6..0.95.
const float TER_BASE_WL = 3800.0, TER_LAC = 2.13;
vec2 terrainDetail(vec3 dir, int oct) {
  vec3 p = dir * (PLANET_R / TER_BASE_WL);
  float hills = 0.0, mtn = 0.0, amp = 1.0, ampM = 1.0;
  vec3 g = vec3(0.0);
  for (int i = 0; i < 12; i++) {
    if (i >= oct) break;
    vec4 n = noised3(p);
    g += n.yzw;
    float gg = dot(g, g);
    hills += amp * n.x / (1.0 + 0.2 * gg);
    float sa = sqrt(n.x * n.x + 0.0025);               // |n| with a slightly rounded crest
    float r = 1.05 - sa;
    float rn = r * r * 1.814 - 1.0;                    // ridged, back in -1..1
    float sh = i == 0 ? 0.3 : (i < 5 ? 0.9 : 0.5);
    mtn += ampM * (n.x + (rn - n.x) * sh) / (1.0 + 0.06 * gg);   // gentler damping: rugged slopes
    amp *= 0.5;
    ampM *= i == 0 ? 0.5 : 0.56;
    p = (M3 * p) * TER_LAC;
  }
  return vec2(hills, mtn);
}

float terrainCompose(TerMacro M, vec2 D) {
  float h = M.base + M.hillAmp * D.x + M.mtnAmp * ((D.y + 0.9) * 0.7 - 0.2);
  if (h > TER_SOFT0) h = TER_SOFT0 + TER_SOFTW * tanh((h - TER_SOFT0) / TER_SOFTW);
  return h;
}

// highest the detail can push the ground above the macro field
float terrainTop(TerMacro M) {
  return min(M.base + M.hillAmp * TER_HILLMAX + M.mtnAmp * ((TER_MTNMAX + 0.9) * 0.7 - 0.2), TER_SOFT0 + TER_SOFTW);
}

float terrainHeight(vec3 dir, int oct) {
  return terrainCompose(terrainMacro(dir), terrainDetail(dir, oct));
}

// octaves whose features are still bigger than ~2 pixels at distance t (normal); the trace uses fewer
float terrainOctF(float t) { return log2(3.8e6 / (t + 30.0)) * 0.917; }   // 0.917 = 1 / log2(TER_LAC)
int terrainLOD(float t) { return int(clamp(terrainOctF(t), 3.0, 12.0)); }
int terrainTraceOct(float t) {
  float q = uQuality == 0 ? 3.0 : 2.0;
  return int(clamp(terrainOctF(t) - q, 2.0, 10.0));
}

float traceTerrain(vec3 ro, vec3 rd, float tMax, int steps) {
  vec2 b = raySphere(ro, rd, PLANET_R + HMAX);
  if (b.y <= 0.0) return -1.0;
  float t = max(b.x, 0.0);
  tMax = min(tMax, b.y);
  float tPrev = t;
  for (int i = 0; i < 400; i++) {
    if (i >= steps || t > tMax) break;
    vec3 p = ro + rd * t;
    float r = length(p);
    vec3 dir = p / r;
    TerMacro M = terrainMacro(dir);
    float alt = r - PLANET_R;
    float hb = alt - terrainTop(M);
    float eps = 0.0012 * t;
    if (hb > eps) {                                  // clear of anything the detail could build here
      // the bound surface is smooth (slope < ~0.4 almost everywhere): level and rising rays may stride far
      // ahead; an overshoot into a rare steep spot (a sea cliff) is caught by the next sample + bisection
      tPrev = t;
      t += max(hb / max(0.4 - dot(rd, dir), 0.25), 0.3 + 0.0006 * t);
      continue;
    }
    int o = terrainTraceOct(t);
    float h = alt - terrainCompose(M, terrainDetail(dir, o));
    if (h < eps) {
      if (h < 0.0) {
        float lo = tPrev, hi = t;
        for (int j = 0; j < 6; j++) {
          float m = 0.5 * (lo + hi);
          vec3 q = ro + rd * m;
          float rq = length(q);
          if (rq - PLANET_R - terrainHeight(q / rq, o) < 0.0) hi = m; else lo = m;
        }
        t = lo;
      }
      return t;
    }
    tPrev = t;
    t += max(0.5 * h, 0.3 + 0.0006 * t);
  }
  return -1.0;
}

vec3 terrainNormal(vec3 p, float t) {
  vec3 up = normalize(p);
  int oct = terrainLOD(t);
  vec3 ax = abs(up.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 t1 = normalize(cross(ax, up)), t2 = cross(up, t1);
  float e = 0.2 + t * 0.0012;
  float er = e / PLANET_R;
  float h0 = terrainHeight(up, oct);
  float h1 = terrainHeight(normalize(up + t1 * er), oct);
  float h2 = terrainHeight(normalize(up + t2 * er), oct);
  float k = (PLANET_R + h0) / PLANET_R;              // the surface is a sphere: arc length grows with height
  vec3 n = normalize(up * (e * k) - t1 * (h1 - h0) - t2 * (h2 - h0));
  return n;
}

// Soft shadow toward the sun from surface point p (seen from distance tView). Near p it samples the same octaves
// as the traced surface (fewer would put p "inside" a coarser ground: false blotchy shadows); farther out only
// the octaves that are large compared with the distance travelled, since small blockers there only soften.
float terrainSoftShadow(vec3 p, vec3 l, float t0, float tView) {
  float res = 1.0, t = t0;
  int n = uQuality == 0 ? 14 : 28;
  int oP = min(terrainTraceOct(tView), 9);          // octave 10+ is under ~0.5 m: covered by the start offset
  for (int i = 0; i < 28; i++) {
    if (i >= n) break;
    vec3 q = p + l * t;
    float r = length(q);
    if (r > PLANET_R + TER_SOFT0 + TER_SOFTW) break;
    vec3 dir = q / r;
    TerMacro M = terrainMacro(dir);
    float alt = r - PLANET_R;
    float h = alt - terrainTop(M);
    if (10.0 * h / t < res) {
      int o = min(oP, int(clamp(terrainOctF(t * 6.0), 3.0, 12.0)));
      h = alt - terrainCompose(M, terrainDetail(dir, o));
    }
    res = min(res, 10.0 * h / t);
    if (res < 0.003) break;
    t += clamp(h * 0.6, 2.0 + 0.04 * t, 400.0);
  }
  return smoothstep(0.0, 1.0, res);
}

// --- materials ---
float terBand(float x, float a, float b, float s) { return smoothstep(a - s, a + s, x) * (1.0 - smoothstep(b - s, b + s, x)); }

// sand with patches of weed / reef; the fine pattern only when the camera is low enough to resolve it
vec3 seabedAlbedo(vec3 dir) {
  float fineF = clamp(1.0 - uCamAlt / 5000.0, 0.0, 1.0);
  float n = noise3(dir * 130.0) * 0.6;
  if (fineF > 0.0) n += (noise3(dir * 900.0) * 0.4 + noise3(dir * 3100.0) * 0.2) * fineF;
  vec3 sand = vec3(0.62, 0.56, 0.42);
  vec3 weed = vec3(0.17, 0.22, 0.12);
  return mix(sand, weed, smoothstep(0.1, 0.6, n));
}

// D3: the first three detail octaves at this point (big ridges and valleys), used to put greener valleys,
// barer crests, snow-filled gullies and some large-scale occlusion into the colour.
vec3 terrainAlbedo(vec3 p, vec3 n, vec3 up, TerMacro M, vec2 D3, float t, out float snow, out float wetness) {
  float h = length(p) - PLANET_R;
  float slope = dot(n, up);
  float lat = abs(up.y);
  float fine = clamp(1.0 - t / 3000.0, 0.0, 1.0);             // fade out sub-pixel colour noise with distance
  float nc = noise3(up * 9.0 + vec3(4.0, 1.0, -2.0));         // ~7 km climate variation
  float n1 = noise3(up * 40.0 + vec3(-1.3, 2.2, 0.4));        // ~1.5 km
  float n2 = noise3(up * 180.0 + 3.0);                        // ~330 m
  float n3 = noise3(p * 0.03) * fine;                         // ~33 m
  float n4 = noise3(p * 0.6) * clamp(1.0 - t / 250.0, 0.0, 1.0);   // ~1.7 m grain near the camera
  float mtnF = clamp(M.mtnAmp / 900.0, 0.0, 1.0);
  float valley = mix(smoothstep(0.3, -0.5, D3.x), smoothstep(0.0, -0.8, D3.y), mtnF);   // 1 in valleys, 0 on crests
  // climate: wet tropics, dry subtropics, wet temperate belt, cold poles; interiors drier, valleys and ranges wetter
  float moist = 0.12 + 0.3 * (1.0 - smoothstep(0.0, 0.28, lat)) - 0.35 * terBand(lat, 0.30, 0.52, 0.08)
              + 0.25 * terBand(lat, 0.6, 0.8, 0.08);
  moist += 0.45 * noise3(up * 3.0 + vec3(1.0, -3.0, 2.0)) + 0.2 * nc + 0.1 * n1;
  moist += -0.4 * smoothstep(0.08, 0.45, M.coast) + 0.2 * smoothstep(0.3, 0.8, M.belt) + 0.22 * valley - 0.08;
  float temp = 1.05 - 1.15 * lat * lat - max(h, 0.0) / 1500.0 + 0.08 * nc;
  // ground cover
  vec3 sandD = mix(vec3(0.50, 0.41, 0.28), vec3(0.47, 0.29, 0.17), smoothstep(-0.3, 0.5, nc + 0.5 * n1));
  vec3 steppe = mix(vec3(0.33, 0.29, 0.18), vec3(0.27, 0.25, 0.15), 0.5 + 0.5 * n2);
  vec3 grass = mix(vec3(0.10, 0.16, 0.045), vec3(0.20, 0.22, 0.09), 0.5 + 0.5 * n2);
  vec3 forest = mix(vec3(0.028, 0.055, 0.02), vec3(0.05, 0.08, 0.03), 0.5 + 0.5 * n3);
  vec3 tundra = vec3(0.25, 0.23, 0.18);
  vec3 g = mix(sandD, steppe, smoothstep(-0.45, -0.18, moist + 0.06 * n2));
  g = mix(g, grass, smoothstep(-0.18, 0.06, moist + 0.06 * n2));
  g = mix(g, forest, smoothstep(0.08, 0.35, moist + 0.12 * n3 + 0.08 * n2) * smoothstep(0.25, 0.45, temp));
  g = mix(g, tundra, smoothstep(0.32, 0.12, temp));
  g *= 0.86 + 0.28 * (0.5 + 0.5 * n3) + 0.12 * n4;
  // scattered shrubs / tussocks on dry and grassy ground: ~1 m dark specks close up, their mean tint far away
  float shrubZone = smoothstep(-0.5, -0.15, moist) * (1.0 - smoothstep(0.05, 0.3, moist)) * smoothstep(0.2, 0.4, temp);
  float shrubNear = clamp(1.0 - (t - 60.0) / 240.0, 0.0, 1.0);
  float shrub = 0.18;
  if (shrubNear > 0.0) shrub = mix(0.18, smoothstep(0.5, 0.62, noise3(p * 0.9 + 7.0)), shrubNear);
  g = mix(g, vec3(0.09, 0.10, 0.05), shrub * shrubZone);
  // rock: grey granite, red sandstone in dry country, black basalt around volcanoes and lava fields; strata
  float dry = smoothstep(0.0, -0.4, moist);
  float lava = smoothstep(0.2, 0.75, M.volc + 0.6 * M.belt * smoothstep(0.35, 0.7, nc));
  vec3 rock = mix(vec3(0.25, 0.23, 0.21), vec3(0.42, 0.26, 0.16), dry);
  rock = mix(rock, vec3(0.075, 0.07, 0.072), lava);
  float strata = sin(h * 0.12 + 5.0 * n2 + 3.0 * n3);        // layered rock, only on real cliffs
  rock *= 0.84 + 0.16 * strata * smoothstep(0.62, 0.35, slope) + 0.14 * n4 + 0.14 * n3;
  float steep = 1.0 - smoothstep(0.68, 0.86, slope + 0.08 * n3 + 0.05 * valley);
  float bare = smoothstep(800.0, 1080.0, h + 120.0 * n2 + 150.0 * (0.5 - valley)) * (1.0 - steep);  // above the tree line
  vec3 col = mix(g, mix(tundra, rock, 0.6), bare);
  col = mix(col, rock, steep);
  col = mix(col, rock * 0.8, lava * 0.7 * (1.0 - steep));
  // beaches (dark sand near the volcanoes), wet sand at the waterline
  // a strip ~50-150 m wide along the shore (by height, and by distance inland via the continent field)
  float beach = smoothstep(2.2, 0.9, h + 0.8 * n3) * smoothstep(0.009, 0.003, M.coast + 0.002 * n2)
              * smoothstep(0.75, 0.92, slope) * (1.0 - 0.85 * M.cliff);
  beach = max(beach, smoothstep(0.9, 0.3, h) * smoothstep(0.6, 0.8, slope));
  vec3 sand = mix(vec3(0.66, 0.59, 0.44), vec3(0.15, 0.14, 0.14), lava);
  sand *= 0.92 + 0.08 * n4;
  col = mix(col, sand, beach);
  col *= 0.45;                                                // overall land albedo (Earth-like: dark from space)
  wetness = beach * smoothstep(0.7, 0.15, h);
  col *= 1.0 - 0.45 * wetness;
  // snow: high peaks (lower snow line toward the poles), gullies keep it, crests and cliffs shed it; polar ice
  float line = 1260.0 - 1150.0 * lat * lat + 90.0 * n1 + 70.0 * n2 + 40.0 * n3 - 160.0 * valley;
  snow = smoothstep(line, line + 150.0, h) * smoothstep(0.62, 0.8, slope + 0.15 * n3 + 0.12 * valley + 0.08 * n2);
  snow = max(snow, smoothstep(0.80, 0.86, lat + 0.03 * n1 + 0.02 * n3) * smoothstep(0.3, 0.55, slope));
  snow *= smoothstep(0.0, 2.0, h);
  col = mix(col, vec3(0.86, 0.89, 0.95) * (0.96 + 0.04 * n4), snow);
  return col;
}

vec3 shadeTerrain(vec3 p, vec3 n, vec3 rd, float t) {
  vec3 up = normalize(p);
  TerMacro M = terrainMacro(up);
  vec2 D3 = terrainDetail(up, 3);
  // ground roughness below what the height field resolves: shading-normal bumps at ~5 m / 2 m (to 1.5 km)
  // and ~0.6 m / 0.3 m (to 120 m), faded out before they could shimmer
  float mesoF = clamp(1.0 - t / 1500.0, 0.0, 1.0);
  if (mesoF > 0.0) {
    float rough = mix(0.4, 1.0, 1.0 - smoothstep(0.65, 0.9, dot(n, up)));   // rocky slopes are rougher
    vec3 g = noised3(p * 0.2).yzw * 0.6 + noised3(p * 0.47).yzw * 0.3;
    float microF = clamp(1.0 - t / 120.0, 0.0, 1.0);
    if (microF > 0.0) g += (noised3(p * 1.7).yzw * 0.5 + noised3(p * 3.1).yzw * 0.25) * microF;
    g -= n * dot(g, n);
    n = normalize(n - g * 0.3 * rough * mesoF);
  }
  float snow, wet;
  vec3 alb = terrainAlbedo(p, n, up, M, D3, t, snow, wet);
  float dif = max(dot(n, uSunDir), 0.0);
  float sh = 1.0;
  if (dif > 0.0 && t < 40000.0) sh = terrainSoftShadow(p + up * (0.3 + 0.002 * t), uSunDir, 1.0 + 0.004 * t, t);
  sh *= cloudShadow(p);
  // occlusion: valley floors and gullies see less sky; steep walls see half of it
  float mtnF = clamp(M.mtnAmp / 900.0, 0.0, 1.0);
  float cav = mix(smoothstep(0.4, -0.6, D3.x) * 0.3, smoothstep(0.1, -0.9, D3.y) * 0.45, mtnF);
  float ao = (1.0 - cav) * (0.7 + 0.3 * max(dot(n, up), 0.0));
  vec3 sun = sunLight(p);
  vec3 amb = skyAmbient(p, n) * ao;
  // warm light bounced off the sunlit ground opposite
  vec3 bounce = sun * alb * 0.08 * clamp(dot(up, uSunDir), 0.0, 1.0) * (1.0 - max(dot(n, up), 0.0)) * ao;
  vec3 col = alb * (sun * dif * sh + amb + bounce);
  // sheen on snow and wet sand
  vec3 hv = normalize(uSunDir - rd);
  float spec = pow(max(dot(n, hv), 0.0), mix(12.0, 120.0, wet)) * (0.04 * snow + 0.35 * wet);
  col += sun * spec * sh * dif;
  return col;
}
`;
