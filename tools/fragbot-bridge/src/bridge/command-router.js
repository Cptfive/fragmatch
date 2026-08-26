const ID = /^[0-9A-F]{32}$/i;

const WIDGET_EVENTS = new Set([
  "STOPWATCH_RESET", "STOPWATCH_PAUSE", "STOPWATCH_RESUME",
  "COUNTDOWN_RESET", "COUNTDOWN_PAUSE", "COUNTDOWN_RESUME",
  "CONFETTIFALL_TRIGGER", "CONFETTIPOP_TRIGGER",
  "SUBATHONTIMER_RESET", "SUBATHONTIMER_PAUSE", "SUBATHONTIMER_RESUME",
  "SUBATHONTIMER_ADDTIME", "WHEELSPIN_SPIN",
  "COUNTER_INCREMENT", "COUNTER_DECREMENT"
]);

export const CAPABILITIES = [
  "meld.status.get", "meld.resources.get", "meld.scene.show", "meld.scene.stage",
  "meld.scene.show_staged", "meld.layer.toggle", "meld.layer.visible", "meld.effect.toggle",
  "meld.audio.toggle_mute", "meld.audio.toggle_monitor", "meld.audio.set_gain",
  "meld.stream.start", "meld.stream.stop", "meld.stream.toggle",
  "meld.record.start", "meld.record.stop", "meld.record.toggle",
  "meld.screenshot", "meld.screenshot.vertical", "meld.clip.record",
  "meld.replay.show", "meld.replay.dismiss", "meld.media.play", "meld.media.pause",
  "meld.media.seek", "meld.widget.event"
];

export class CommandRouter {
  constructor({ meldClient, logger }) { this.meldClient = meldClient; this.logger = logger; }
  async execute(action, args = {}) {
    if (!CAPABILITIES.includes(action)) fail("ACTION_NOT_ALLOWED", `Unsupported action: ${action}`);
    if (action === "meld.status.get") return this.meldClient.getStatus();
    if (action === "meld.resources.get") return this.meldClient.getResources();
    const meld = this.meldClient.requireMeld();
    switch (action) {
      case "meld.scene.show": return dispatch(meld.showScene, requireId(args.sceneId, "sceneId"));
      case "meld.scene.stage": return dispatch(meld.setStagedScene, requireId(args.sceneId, "sceneId"));
      case "meld.scene.show_staged": return dispatch(meld.showStagedScene);
      case "meld.layer.toggle": return dispatch(meld.toggleLayer, requireId(args.sceneId, "sceneId"), requireId(args.layerId, "layerId"));
      case "meld.layer.visible": {
        const sceneId = requireId(args.sceneId, "sceneId"), layerId = requireId(args.layerId, "layerId"), visible = requireBool(args.visible, "visible");
        if (typeof meld.setProperty === "function" && Number(meld.version ?? 1) >= 2) return dispatch(meld.setProperty, layerId, "visible", visible);
        const layer = this.meldClient.getResources().layers.find(x => x.id === layerId && x.parent === sceneId);
        if (!layer) fail("RESOURCE_NOT_FOUND", "Layer was not found in the specified scene.");
        if (Boolean(layer.visible) !== visible) await dispatch(meld.toggleLayer, sceneId, layerId);
        return { dispatched: true, changed: Boolean(layer.visible) !== visible };
      }
      case "meld.effect.toggle": return dispatch(meld.toggleEffect, requireId(args.sceneId, "sceneId"), requireId(args.layerId, "layerId"), requireId(args.effectId, "effectId"));
      case "meld.audio.toggle_mute": return dispatch(meld.toggleMute, requireId(args.trackId, "trackId"));
      case "meld.audio.toggle_monitor": return dispatch(meld.toggleMonitor, requireId(args.trackId, "trackId"));
      case "meld.audio.set_gain": return dispatch(meld.setGain, requireId(args.trackId, "trackId"), requireNumber(args.gain, "gain", 0, 1));
      case "meld.stream.start": return dispatch(meld.sendCommand, "meld.startStreamingAction");
      case "meld.stream.stop": return dispatch(meld.sendCommand, "meld.stopStreamingAction");
      case "meld.stream.toggle": return dispatch(meld.sendCommand, "meld.toggleStreamingAction");
      case "meld.record.start": return dispatch(meld.sendCommand, "meld.startRecordingAction");
      case "meld.record.stop": return dispatch(meld.sendCommand, "meld.stopRecordingAction");
      case "meld.record.toggle": return dispatch(meld.sendCommand, "meld.toggleRecordingAction");
      case "meld.screenshot": return dispatch(meld.sendCommand, "meld.screenshot");
      case "meld.screenshot.vertical": return dispatch(meld.sendCommand, "meld.screenshot.vertical");
      case "meld.replay.show": return dispatch(meld.sendCommand, "meld.replay.show");
      case "meld.replay.dismiss": return dispatch(meld.sendCommand, "meld.replay.dismiss");
      case "meld.clip.record": return args.duration == null || args.duration === "" ? dispatch(meld.sendCommand, "meld.recordClip") : dispatch(meld.sendCommandWithArgs, "meld.recordClip", [requireNumber(args.duration, "duration", 0, 90)]);
      case "meld.media.play": return dispatch(meld.callFunction, requireId(args.layerId, "layerId"), "play");
      case "meld.media.pause": return dispatch(meld.callFunction, requireId(args.layerId, "layerId"), "pause");
      case "meld.media.seek": return dispatch(meld.callFunctionWithArgs, requireId(args.layerId, "layerId"), "seekTo", [requireNumber(args.seconds, "seconds", 0, Number.MAX_SAFE_INTEGER)]);
      case "meld.widget.event": {
        const event = String(args.event || ""); if (!WIDGET_EVENTS.has(event)) fail("BAD_ARGUMENT", "Unsupported Meld widget event.");
        const data = event === "SUBATHONTIMER_ADDTIME" ? { amount: requireNumber(args.data?.amount, "data.amount", 0, 86400) } : undefined;
        return data === undefined ? dispatch(meld.sendStreamEvent, event) : dispatch(meld.sendStreamEvent, event, data);
      }
    }
  }
}

async function dispatch(fn, ...args) {
  if (typeof fn !== "function") fail("MELD_UNSUPPORTED", "This Meld build does not expose the requested method.");
  try {
    const result = fn(...args);
    if (result && typeof result.then === "function") await Promise.race([result.catch(() => undefined), new Promise(resolve => setTimeout(resolve, 750))]);
    return { dispatched: true };
  } catch (err) { fail("MELD_COMMAND_FAILED", err?.message || "Meld command failed."); }
}
function requireId(value, name) { const text = String(value || ""); if (!ID.test(text)) fail("BAD_ARGUMENT", `${name} must be a Meld 32-character object ID.`); return text; }
function requireBool(value, name) { if (typeof value !== "boolean") fail("BAD_ARGUMENT", `${name} must be boolean.`); return value; }
function requireNumber(value, name, min, max) { const n = Number(value); if (!Number.isFinite(n) || n < min || n > max) fail("BAD_ARGUMENT", `${name} must be between ${min} and ${max}.`); return n; }
function fail(code, message) { const err = new Error(message); err.code = code; throw err; }
