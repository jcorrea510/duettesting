// Audio: a procedural soundscape that follows the camera (space hum -> wind -> surf). Silent until the user asks.
// OWNER: audio agent.
//
// CONTRACT: export function createAudio(app) -> { start(), stop(), toggle(), get on() }
// Drive it from app.onFrame (push a function taking dt) and read app.rig.altitude, app.rig.orbitness(), app.sunDir().
export function createAudio(app) {
  return { start() {}, stop() {}, toggle() {}, get on() { return false; } };
}
