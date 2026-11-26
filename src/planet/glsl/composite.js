// Composite: one ray per pixel, decides what it hits and assembles the frame.
// OWNER: main session.
export const COMPOSITE = /* glsl */ `
out vec4 outColor;

vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = (2.0 * frag - uRes) / uRes.y;
  vec3 ro = uCamPos;
  vec3 rd = normalize(uv.x * uCamR + uv.y * uCamU + uFocal * uCamF);
  float jitter = hash2(ivec2(frag) + ivec2(int(uTime * 61.0) * 7, 3));

  int steps = uQuality == 2 ? 360 : (uQuality == 1 ? 200 : 130);

  float tOcean = raySphere(ro, rd, PLANET_R).x;
  float tLand = traceTerrain(ro, rd, tOcean > 0.0 ? tOcean : 1e9, steps);

  vec3 col;
  float tHit;
  if (tLand > 0.0) {
    tHit = tLand;
    vec3 p = ro + rd * tLand;
    vec3 n = terrainNormal(p, tLand);
    col = shadeTerrain(p, n, rd, tLand) + nightSurfaceGlow(p, n);
  } else if (tOcean > 0.0) {
    tHit = tOcean;
    col = shadeOcean(ro + rd * tOcean, rd, tOcean);
  } else {
    tHit = 1e12;
    col = spaceBackground(rd, true);
  }

  vec4 cl = cloudLayer(ro, rd, tHit);
  col = col * (1.0 - cl.a) + cl.rgb;

  vec3 L, T;
  atmosphere(ro, rd, tHit, jitter, L, T);
  col = col * T + L;
  col += extrasEmission(ro, rd, tHit);

  col *= uExposure;
  col = aces(col);
  col = pow(col, vec3(1.0 / 2.2));
  vec2 q = frag / uRes;
  col *= 0.6 + 0.4 * pow(16.0 * q.x * q.y * (1.0 - q.x) * (1.0 - q.y), 0.15);
  col += (jitter - 0.5) / 255.0;
  outColor = vec4(col, 1.0);
}
`;
