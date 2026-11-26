// Composite: one ray per pixel, decides what it hits and assembles the frame.
// OWNER: main session (performance agent).
//
// The main pass renders into an RGBA8 texture at the adaptive render resolution (see main.js). Two small post
// passes then turn that into the final picture: RESOLVE_FS (temporal accumulation, only while the camera is
// still) and UPSCALE_FS (sharp Catmull-Rom upscale to the canvas). Both are exported from here.
//
// Uniforms owned by this chunk (set by main.js):
//   uPixOff  sub-pixel offset of the primary ray, in pixels (0 while moving; a Halton jitter while the camera is still)
//   uFrame   frame counter used to decorrelate per-pixel noise between frames (0 in ?still renders, so they are deterministic)
export const COMPOSITE = /* glsl */ `
out vec4 outColor;
uniform vec2  uPixOff;
uniform float uFrame;

vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = (2.0 * (frag + uPixOff) - uRes) / uRes.y;
  vec3 ro = uCamPos;
  vec3 rd = normalize(uv.x * uCamR + uv.y * uCamU + uFocal * uCamF);
  float jitter = hash2(ivec2(frag) + ivec2(int(uFrame) * 7, 3));

  vec3 col;
  float tHit = 1e12;
  // Everything except the star field (and extras such as a moon) lives inside the atmosphere sphere.
  // From orbit most of the frame misses it: those pixels skip terrain, ocean, clouds and the atmosphere march.
  vec2 tAtmo = raySphere(ro, rd, ATMO_R);
  if (tAtmo.y <= 0.0) {
    col = spaceBackground(rd, true);
  } else {
    float tOcean = raySphere(ro, rd, PLANET_R).x;
    // land can only be hit inside the R + HMAX shell
    float tLand = -1.0;
    if (raySphere(ro, rd, PLANET_R + HMAX).y > 0.0) {
      int steps = uQuality == 2 ? 360 : (uQuality == 1 ? 200 : 130);
      tLand = traceTerrain(ro, rd, tOcean > 0.0 ? tOcean : 1e9, steps);
    }

    if (tLand > 0.0) {
      tHit = tLand;
      vec3 p = ro + rd * tLand;
      vec3 n = terrainNormal(p, tLand);
      col = shadeTerrain(p, n, rd, tLand) + nightSurfaceGlow(p, n);
    } else if (tOcean > 0.0) {
      tHit = tOcean;
      col = shadeOcean(ro + rd * tOcean, rd, tOcean);
    } else {
      col = spaceBackground(rd, true);
    }

    vec4 cl = cloudLayer(ro, rd, tHit);
    col = col * (1.0 - cl.a) + cl.rgb;

    vec3 L, T;
    atmosphere(ro, rd, tHit, jitter, L, T);
    col = col * T + L;
  }
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

// Full-screen triangle for the post passes.
export const POST_VS = /* glsl */ `#version 300 es
void main() { vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;

// Temporal accumulation at render resolution, used only while the camera is not moving (so there is nothing to
// reproject and no ghosting). The current frame is rendered with a sub-pixel jitter; the history is clamped to
// the current 3x3 neighbourhood so animated things (waves, drifting clouds, the moving sun) cannot leave trails.
export const RESOLVE_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uCur;
uniform sampler2D uHist;
uniform float uBlend;      // weight of the new frame (1 = ignore history)
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 mx = textureSize(uCur, 0) - 1;
  vec3 c = texelFetch(uCur, p, 0).rgb;
  if (uBlend >= 0.999) { outColor = vec4(c, 1.0); return; }
  vec3 lo = c, hi = c;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec3 s = texelFetch(uCur, clamp(p + ivec2(i, j), ivec2(0), mx), 0).rgb;
      lo = min(lo, s); hi = max(hi, s);
    }
  }
  vec3 h = texelFetch(uHist, p, 0).rgb;
  h = clamp(h, lo - 1.0 / 255.0, hi + 1.0 / 255.0);
  outColor = vec4(mix(h, c, uBlend), 1.0);
}
`;

// Upscale to the canvas: 5-tap Catmull-Rom (built from bilinear taps), plus a light edge-only unsharp term that
// grows with the upscale ratio, both clamped to the 2x2 source texels around the sample so there is no ringing or halo.
// When source and destination have the same size it is an exact copy.
export const UPSCALE_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uSrc;
uniform vec2 uSrcSize;
uniform vec2 uDstSize;
uniform float uSharp;
out vec4 outColor;
void main() {
  if (uSrcSize == uDstSize) { outColor = vec4(texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0).rgb, 1.0); return; }
  vec2 pos = gl_FragCoord.xy * (uSrcSize / uDstSize) - 0.5;
  vec2 i0 = floor(pos), f = pos - i0;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 inv = 1.0 / uSrcSize;
  vec2 tA = (i0 - 0.5) * inv;                 // texel i0-1
  vec2 tD = (i0 + 2.5) * inv;                 // texel i0+2
  vec2 tM = (i0 + 0.5 + w2 / w12) * inv;      // between i0 and i0+1, weighted
  float kN = w12.x * w0.y, kW = w0.x * w12.y, kC = w12.x * w12.y, kE = w3.x * w12.y, kS = w12.x * w3.y;
  vec3 c = texture(uSrc, vec2(tM.x, tA.y)).rgb * kN
         + texture(uSrc, vec2(tA.x, tM.y)).rgb * kW
         + texture(uSrc, tM).rgb * kC
         + texture(uSrc, vec2(tD.x, tM.y)).rgb * kE
         + texture(uSrc, vec2(tM.x, tD.y)).rgb * kS;
  c /= (kN + kW + kC + kE + kS);
  ivec2 ip = ivec2(i0), mx = ivec2(uSrcSize) - 1;
  vec3 a = texelFetch(uSrc, clamp(ip, ivec2(0), mx), 0).rgb;
  vec3 b = texelFetch(uSrc, clamp(ip + ivec2(1, 0), ivec2(0), mx), 0).rgb;
  vec3 d = texelFetch(uSrc, clamp(ip + ivec2(0, 1), ivec2(0), mx), 0).rgb;
  vec3 e = texelFetch(uSrc, clamp(ip + ivec2(1, 1), ivec2(0), mx), 0).rgb;
  vec3 lo = min(min(a, b), min(d, e)), hi = max(max(a, b), max(d, e));
  vec3 bl = mix(mix(a, b, f.x), mix(d, e, f.x), f.y);
  // sharpen edges only: flat areas keep their dither/noise unamplified
  vec3 dc = hi - lo;
  c += uSharp * smoothstep(0.012, 0.06, max(dc.r, max(dc.g, dc.b))) * (c - bl);
  outColor = vec4(clamp(c, lo, hi), 1.0);
}
`;
