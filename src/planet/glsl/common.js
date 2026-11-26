// Shared GLSL for every planet pass: version line, constants, uniforms, hashing, noise, geometry.
// OWNER: main session. Other modules may rely on everything declared here.
//
// World space: planet centred at the origin, +Y is the rotation axis (north pole), units are metres.
export const COMMON = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
#define PI 3.14159265359

const float PLANET_R = 60000.0;               // sea level radius
const float HMAX     = 2000.0;                // nothing on the surface rises above PLANET_R + HMAX
const float ATMO_R   = PLANET_R + 16000.0;    // top of the atmosphere
const float CLOUD_R  = PLANET_R + 2600.0;     // cloud layer altitude (shell)
const vec3  SUN_E    = vec3(18.0);            // radiance scale of sunlight (exposure is tuned against this)

uniform vec2  uRes;        // render target size in pixels
uniform float uTime;       // seconds since start (animation clock)
uniform vec3  uCamPos;     // camera position, world space
uniform vec3  uCamR, uCamU, uCamF;   // camera basis (right, up, forward), orthonormal
uniform float uFocal;      // 1 / tan(fovY / 2)
uniform float uCamAlt;     // camera height above sea level, metres
uniform vec3  uSunDir;     // unit vector toward the sun
uniform float uExposure;
uniform int   uQuality;    // 0 fast, 1 normal, 2 photo
uniform uint  uSeed;
uniform sampler2D uTransLUT;   // atmosphere transmittance lookup, see atmosphere.js

// The moon keeps a fixed angle from the sun's azimuth (so it rises and sets everywhere). Shared by ocean and extras.
vec3 moonDirection() {
  float az = atan(uSunDir.z, uSunDir.x) + 3.88;
  const float el = -0.119;
  return vec3(cos(az) * cos(el), sin(el), sin(az) * cos(el));
}
#define MOON_DIR moonDirection()

// ---------- hashing ----------
float hash3(ivec3 p) {
  uvec3 q = uvec3(p + ivec3(1 << 22));
  uint n = (q.x * 1597334677u) ^ (q.y * 3812015801u) ^ (q.z * 2798796415u) ^ (uSeed * 2654435761u);
  n = (n ^ (n >> 16)) * 2246822519u;
  n ^= n >> 13; n *= 3266489917u; n ^= n >> 16;
  return float(n) * (1.0 / 4294967295.0);
}
float hash2(ivec2 p) { return hash3(ivec3(p, 917)); }

// 3D value noise with analytic gradient: returns vec4(value in [-1,1], d/dx, d/dy, d/dz)
vec4 noised3(vec3 x) {
  vec3 f = fract(x);
  ivec3 i = ivec3(floor(x));
  vec3 u  = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec3 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  float a = hash3(i);
  float b = hash3(i + ivec3(1, 0, 0));
  float c = hash3(i + ivec3(0, 1, 0));
  float d = hash3(i + ivec3(1, 1, 0));
  float e = hash3(i + ivec3(0, 0, 1));
  float f1 = hash3(i + ivec3(1, 0, 1));
  float g = hash3(i + ivec3(0, 1, 1));
  float h = hash3(i + ivec3(1, 1, 1));
  float k0 = a, k1 = b - a, k2 = c - a, k3 = e - a, k4 = a - b - c + d;
  float k5 = a - c - e + g, k6 = a - b - e + f1, k7 = -a + b + c - d + e - f1 - g + h;
  float v = k0 + k1 * u.x + k2 * u.y + k3 * u.z + k4 * u.x * u.y + k5 * u.y * u.z + k6 * u.z * u.x + k7 * u.x * u.y * u.z;
  vec3 dv = du * vec3(k1 + k4 * u.y + k6 * u.z + k7 * u.y * u.z,
                      k2 + k5 * u.z + k4 * u.x + k7 * u.z * u.x,
                      k3 + k6 * u.x + k5 * u.y + k7 * u.x * u.y);
  return vec4(-1.0 + 2.0 * v, 2.0 * dv);
}
float noise3(vec3 x) { return noised3(x).x; }

// rotation used between octaves (orthonormal, irrational-ish angles) to hide the lattice
const mat3 M3 = mat3( 0.00,  0.80,  0.60,
                     -0.80,  0.36, -0.48,
                     -0.60, -0.48,  0.64);

// ray / sphere centred at origin: returns (tNear, tFar); both -1 when missed
vec2 raySphere(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd), c = dot(ro, ro) - r * r, h = b * b - c;
  if (h < 0.0) return vec2(-1.0);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}
`;
