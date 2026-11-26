// Extras: things that make the planet feel alive at night and from space (aurora, moon, etc).
// OWNER: night-side agent.
//
// CONTRACT:
//   vec3 extrasEmission(vec3 ro, vec3 rd, float tHit)    additive light along the view ray in front of tHit (e.g. aurora curtains)
//   vec3 nightSurfaceGlow(vec3 p, vec3 n)                additive emission on the dark side of land (keep subtle; no cities: nobody lives here)
// May call anything declared earlier (atmosphere, clouds, terrain, ocean).
export const EXTRAS = /* glsl */ `
vec3 extrasEmission(vec3 ro, vec3 rd, float tHit) { return vec3(0.0); }
vec3 nightSurfaceGlow(vec3 p, vec3 n) { return vec3(0.0); }
`;
