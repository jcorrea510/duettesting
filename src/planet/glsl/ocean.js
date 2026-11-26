// Ocean: the sea-level sphere.
// OWNER: ocean agent.
//
// CONTRACT:
//   vec3 shadeOcean(vec3 p, vec3 rd, float t)    lit water radiance at sea-surface point p (before atmosphere along the view ray)
// May call: terrainHeight (water depth), seabedAlbedo, sunLight, skyAmbient, skyRadiance, cloudShadow, cloudLayer, noise helpers.
export const OCEAN = /* glsl */ `
vec3 shadeOcean(vec3 p, vec3 rd, float t) {
  vec3 up = normalize(p);
  float depth = max(-terrainHeight(up, 6), 0.0);
  vec3 n = up;
  float ndv = max(dot(n, -rd), 0.0);
  float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  vec3 sun = sunLight(p) * cloudShadow(p);
  vec3 trans = exp(-vec3(0.30, 0.075, 0.055) * depth * 2.0);
  vec3 deep = vec3(0.004, 0.02, 0.04);
  vec3 body = mix(deep, seabedAlbedo(up) * 0.5, trans) * (sun * max(dot(up, uSunDir), 0.0) + skyAmbient(p, up));
  vec3 refl = vec3(0.05, 0.1, 0.2) * SUN_E * 0.05;
  vec3 h = normalize(uSunDir - rd);
  vec3 spec = sun * pow(max(dot(n, h), 0.0), 400.0) * 20.0;
  return mix(body, refl, fres) + spec;
}
`;
