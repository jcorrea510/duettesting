// Clouds: a spherical cloud shell around the planet.
// OWNER: clouds agent.
//
// CONTRACT:
//   vec4  cloudLayer(vec3 ro, vec3 rd, float tMax)   premultiplied (rgb radiance * alpha, alpha) of clouds between ro and ro+rd*tMax
//   float cloudShadow(vec3 p)                        fraction of sunlight NOT blocked by clouds at surface point p, [0,1]
//   float cloudCoverage(vec3 dir)                    raw coverage [0,1] at a unit direction (used by other modules, e.g. ocean, audio hints)
// May call: sunTransmittance, sunLight, skyAmbient, noise3/noised3, raySphere, uTime.
export const CLOUDS = /* glsl */ `
float cloudCoverage(vec3 dir) {
  vec3 p = dir * 4.0 + vec3(uTime * 0.004, 0.0, uTime * 0.002);
  float f = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { f += a * noise3(p); p = M3 * p * 2.05; a *= 0.5; }
  return smoothstep(0.05, 0.55, f + 0.1);
}

vec4 cloudLayer(vec3 ro, vec3 rd, float tMax) {
  vec2 s = raySphere(ro, rd, CLOUD_R);
  if (s.y <= 0.0) return vec4(0.0);
  float t = s.x > 0.0 ? s.x : s.y;            // outside the shell: near hit; inside: far hit
  if (t > tMax) return vec4(0.0);
  vec3 p = ro + rd * t;
  vec3 dir = normalize(p);
  float d = cloudCoverage(dir);
  if (d <= 0.001) return vec4(0.0);
  vec3 col = sunLight(p) * (0.75 + 0.25 * d) * 0.32 + skyAmbient(p, dir) * 0.6;
  return vec4(col * d, d);
}

float cloudShadow(vec3 p) {
  vec2 s = raySphere(p, uSunDir, CLOUD_R);
  if (s.y <= 0.0) return 1.0;
  vec3 q = p + uSunDir * s.y;
  return 1.0 - 0.75 * cloudCoverage(normalize(q));
}
`;
