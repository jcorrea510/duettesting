// Atmosphere: physically based single scattering (Rayleigh + Mie) around the planet.
// OWNER: atmosphere agent.
//
// CONTRACT (functions other modules call; keep these signatures):
//   vec3 sunTransmittance(vec3 p)                      light reaching point p from the sun (0 in the planet's shadow), unitless [0,1]
//   vec3 sunLight(vec3 p)                              = SUN_E * sunTransmittance(p)   (radiance-scaled sunlight at p)
//   vec3 skyAmbient(vec3 p, vec3 n)                    irradiance from the sky dome onto a surface with normal n at p
//   void atmosphere(vec3 ro, vec3 rd, float tEnd, float jitter, out vec3 inscatter, out vec3 trans)
//                                                      light scattered toward the camera along ro->ro+rd*tEnd, and transmittance
//   vec3 skyRadiance(vec3 p, vec3 dir)                 what you'd see looking from p along dir to space (atmosphere + space background)
//   vec3 spaceBackground(vec3 rd, bool withSun)        stars, sun disc etc. outside the atmosphere
//
// JS side: TRANS_LUT_FS renders the transmittance table once (see main.js: LUT_W x LUT_H, RGBA8).
export const TRANS_LUT_W = 256, TRANS_LUT_H = 64;

export const ATMOSPHERE = /* glsl */ `
const vec3  BETA_R = vec3(5.8e-6, 13.5e-6, 33.1e-6) * 6.0;
const float BETA_M = 21e-6 * 6.0;
const float H_R = 1600.0, H_M = 380.0, MIE_G = 0.8;

// LUT parameterisation: u = view zenith cosine (sqrt-warped around the horizon), v = sqrt(altitude fraction)
vec2 transUV(float h, float mu) {
  float u = 0.5 + 0.5 * sign(mu) * sqrt(abs(mu));
  float v = sqrt(clamp(h / (ATMO_R - PLANET_R), 0.0, 1.0));
  return vec2(u, v);
}

vec3 sunTransmittance(vec3 p) {
  float r = length(p);
  vec3 up = p / r;
  float mu = dot(up, uSunDir);
  return texture(uTransLUT, transUV(r - PLANET_R, mu)).rgb;
}
vec3 sunLight(vec3 p) { return SUN_E * sunTransmittance(p); }

float phaseR(float mu) { return 3.0 / (16.0 * PI) * (1.0 + mu * mu); }
float phaseM(float mu) {
  float g = MIE_G;
  return 3.0 / (8.0 * PI) * ((1.0 - g * g) * (1.0 + mu * mu)) / ((2.0 + g * g) * pow(max(1.0 + g * g - 2.0 * g * mu, 1e-4), 1.5));
}

vec3 skyAmbient(vec3 p, vec3 n) {
  vec3 up = normalize(p);
  float sunUp = dot(up, uSunDir);
  vec3 zenith = vec3(0.10, 0.20, 0.42) * 0.11;
  vec3 dusk   = vec3(0.30, 0.18, 0.20) * 0.05;
  float day = smoothstep(-0.25, 0.35, sunUp);
  vec3 c = mix(dusk * smoothstep(-0.35, 0.0, sunUp), zenith, day);
  return SUN_E * c * (0.55 + 0.45 * dot(n, up));
}

void atmosphere(vec3 ro, vec3 rd, float tEnd, float jitter, out vec3 inscatter, out vec3 trans) {
  inscatter = vec3(0.0); trans = vec3(1.0);
  vec2 a = raySphere(ro, rd, ATMO_R);
  if (a.y <= 0.0) return;
  float t0 = max(a.x, 0.0), t1 = min(a.y, tEnd);
  if (t1 <= t0) return;
  const int N = 16;
  float dt = (t1 - t0) / float(N);
  float mu = dot(rd, uSunDir);
  float pR = phaseR(mu), pM = phaseM(mu);
  for (int i = 0; i < N; i++) {
    float t = t0 + (float(i) + jitter) * dt;
    vec3 p = ro + rd * t;
    float h = max(length(p) - PLANET_R, 0.0);
    float dR = exp(-h / H_R), dM = exp(-h / H_M);
    vec3 ext = BETA_R * dR + BETA_M * 1.11 * dM;
    vec3 scat = (BETA_R * dR * pR + BETA_M * dM * pM) * sunTransmittance(p);
    vec3 stepT = exp(-ext * dt);
    inscatter += trans * scat * (1.0 - stepT) / max(ext, vec3(1e-12));
    trans *= stepT;
  }
  inscatter *= SUN_E;
}

vec3 spaceBackground(vec3 rd, bool withSun) {
  // stars on a 3D lattice
  vec3 q = rd * 300.0;
  ivec3 c = ivec3(floor(q));
  float h = hash3(c), h2 = hash3(c + ivec3(91, 17, 3));
  vec3 f = fract(q) - 0.5;
  float star = smoothstep(0.09, 0.0, length(f)) * step(0.993, h) * (0.3 + 3.0 * h2 * h2);
  vec3 col = mix(vec3(0.7, 0.8, 1.0), vec3(1.0, 0.85, 0.7), h2) * star * 0.25;
  if (withSun) {
    float m = dot(rd, uSunDir);
    col += SUN_E * 40.0 * smoothstep(0.99985, 0.99992, m);
  }
  return col;
}

vec3 skyRadiance(vec3 p, vec3 dir) {
  vec3 L, T;
  float tg = raySphere(p, dir, PLANET_R).x;
  atmosphere(p, dir, tg > 0.0 ? tg : 1e9, 0.5, L, T);
  return L + T * (tg > 0.0 ? vec3(0.0) : spaceBackground(dir, false));
}
`;

// Fragment shader for the transmittance table: COMMON + ATMOSPHERE + this.
export const TRANS_LUT_FS = /* glsl */ `
out vec4 outColor;
void main() {
  vec2 uv = gl_FragCoord.xy / vec2(${TRANS_LUT_W}.0, ${TRANS_LUT_H}.0);
  float s = uv.x * 2.0 - 1.0;
  float mu = sign(s) * s * s;
  float h = uv.y * uv.y * (ATMO_R - PLANET_R);
  vec3 ro = vec3(0.0, PLANET_R + h, 0.0);
  vec3 rd = vec3(sqrt(max(0.0, 1.0 - mu * mu)), mu, 0.0);
  // the planet (with a softened edge for a believable terminator) blocks the sun
  vec2 g = raySphere(ro, rd, PLANET_R - 400.0);
  float t1 = raySphere(ro, rd, ATMO_R).y;
  vec3 od = vec3(0.0);
  const int N = 40;
  float dt = t1 / float(N);
  for (int i = 0; i < N; i++) {
    vec3 p = ro + rd * (float(i) + 0.5) * dt;
    float hh = max(length(p) - PLANET_R, 0.0);
    od += (BETA_R * exp(-hh / H_R) + BETA_M * 1.11 * exp(-hh / H_M)) * dt;
  }
  vec3 T = exp(-od);
  if (g.x > 0.0) T = vec3(0.0);
  outColor = vec4(T, 1.0);
}
`;
