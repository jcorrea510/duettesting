// UI: intro hook, buttons, explainer panel, credit.
// OWNER: UI agent.
//
// CONTRACT: export function initUI(app) -> { ready() }  (ready is called once the shaders are compiled)
// app: { state, rig, gl, canvas, params, sunDir, onFrame[], audio }
export function initUI(app) {
  const land = document.getElementById('land');
  land?.addEventListener('click', () => { app.rig.land(); app.audio?.start?.(); });
  return {
    ready() { document.body.classList.add('ready'); },
  };
}
