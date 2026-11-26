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
export const TERRAIN = /* glsl */ `
float continentField(vec3 dir) {
  vec3 p = dir * 2.2;
  return 0.6 * noise3(p) + 0.3 * noise3(M3 * p * 2.1 + vec3(3.1, 1.7, -2.3)) + 0.1 * noise3(M3 * M3 * p * 4.3);
}

float terrainHeight(vec3 dir, int oct) {
  float c = continentField(dir);
  vec3 p = dir * (PLANET_R / 1100.0);
  float a = 0.0, b = 1.0;
  vec3 d = vec3(0.0);
  for (int i = 0; i < 12; i++) {
    if (i >= oct) break;
    vec4 n = noised3(p);
    d += n.yzw;
    a += b * n.x / (1.0 + dot(d, d));     // slopes damp finer octaves: erosion-like ridges and valleys
    b *= 0.5;
    p = M3 * p * 2.02;
  }
  float land = smoothstep(-0.05, 0.45, c);
  float relief = 0.5 + 0.5 * a;
  relief *= relief * (1.6 - 0.6 * relief);
  return mix(-260.0, 12.0, land) + relief * (30.0 + 900.0 * land * land) - 20.0;
}

int terrainLOD(float t) {
  return int(clamp(11.0 - log2(1.0 + t / 250.0) * 1.6, 3.0, 11.0));
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
    int o = terrainLOD(t) - 2;
    float h = r - PLANET_R - terrainHeight(p / r, o);
    if (h < 0.0012 * t) {
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
    t += max(0.45 * h, 0.3 + 0.0006 * t);
  }
  return -1.0;
}

vec3 surfacePoint(vec3 dir, int oct) { return dir * (PLANET_R + terrainHeight(dir, oct)); }

vec3 terrainNormal(vec3 p, float t) {
  vec3 up = normalize(p);
  int oct = terrainLOD(t) + 1;
  vec3 ax = abs(up.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 t1 = normalize(cross(ax, up)), t2 = cross(up, t1);
  float e = (0.15 + t * 0.0015) / PLANET_R;
  vec3 s0 = surfacePoint(up, oct);
  vec3 s1 = surfacePoint(normalize(up + t1 * e), oct);
  vec3 s2 = surfacePoint(normalize(up + t2 * e), oct);
  vec3 n = normalize(cross(s2 - s0, s1 - s0));
  return dot(n, up) < 0.0 ? -n : n;
}

float terrainSoftShadow(vec3 p, vec3 l) {
  float res = 1.0, t = 2.0;
  for (int i = 0; i < 32; i++) {
    vec3 q = p + l * t;
    float r = length(q);
    if (r > PLANET_R + HMAX) break;
    float h = r - PLANET_R - terrainHeight(q / r, i < 8 ? 8 : 6);
    res = min(res, 8.0 * h / t);
    if (res < 0.003) break;
    t += clamp(h * 0.7, 3.0, 300.0);
  }
  return smoothstep(0.0, 1.0, res);
}

vec3 seabedAlbedo(vec3 dir) { return vec3(0.55, 0.50, 0.38); }

vec3 terrainAlbedo(vec3 p, vec3 n, vec3 up, out float snow) {
  vec3 dir = up;
  float h = length(p) - PLANET_R;
  float slope = dot(n, up);
  float lat = abs(dir.y);
  vec3 q = dir * (PLANET_R / 60.0);
  float n1 = noise3(q * 0.4), n2 = noise3(q * 3.0);
  float moist = noise3(dir * 6.0 + 4.0) * 0.6 + 0.4 * noise3(dir * 15.0);
  vec3 rock  = mix(vec3(0.17, 0.14, 0.12), vec3(0.36, 0.31, 0.27), 0.5 + 0.5 * n2);
  vec3 grass = mix(vec3(0.07, 0.11, 0.03), vec3(0.19, 0.20, 0.07), 0.5 + 0.5 * n1);
  vec3 sandD = vec3(0.62, 0.47, 0.30);
  vec3 veg = mix(sandD, grass, smoothstep(-0.25, 0.15, moist + (lat - 0.3) * 0.6));
  float vegMask = smoothstep(0.72, 0.86, slope) * (1.0 - smoothstep(500.0, 700.0, h + n1 * 80.0));
  vec3 col = mix(rock, veg, vegMask);
  float beach = smoothstep(6.0, 1.0, h) * smoothstep(0.6, 0.8, slope);
  col = mix(col, vec3(0.62, 0.55, 0.40), beach);
  snow = smoothstep(0.0, 0.08, lat - 0.78 + 0.05 * n1 + h * 0.00012) + smoothstep(650.0, 800.0, h + n1 * 80.0) * smoothstep(0.5, 0.75, slope);
  snow = clamp(snow, 0.0, 1.0);
  col = mix(col, vec3(0.9, 0.93, 0.97), snow);
  return col;
}

vec3 shadeTerrain(vec3 p, vec3 n, vec3 rd, float t) {
  vec3 up = normalize(p);
  float snow;
  vec3 alb = terrainAlbedo(p, n, up, snow);
  float dif = max(dot(n, uSunDir), 0.0);
  float sh = 1.0;
  if (dif > 0.0 && t < 30000.0) sh = terrainSoftShadow(p + up * 1.0, uSunDir);
  sh *= cloudShadow(p);
  vec3 col = alb * (sunLight(p) * dif * sh + skyAmbient(p, n));
  return col;
}
`;
