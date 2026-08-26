import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { QWebChannel } from "./qwebchannel.js";

const MELD_URL = "ws://127.0.0.1:13376";
const MIN_RETRY = 1_000;
const MAX_RETRY = 10_000;
const HANDSHAKE_TIMEOUT = 10_000;

export class MeldClient extends EventEmitter {
  constructor({ logger }) {
    super();
    this.logger = logger;
    this.ws = null;
    this.meld = null;
    this.running = false;
    this.retryMs = MIN_RETRY;
    this.retryTimer = null;
    this.handshakeTimer = null;
    this.generation = 0;
  }
  get connected() { return Boolean(this.meld && this.ws?.readyState === WebSocket.OPEN); }
  start() { if (this.running) return; this.running = true; this.#connect(); }
  stop() { this.running = false; clearTimeout(this.retryTimer); clearTimeout(this.handshakeTimer); this.retryTimer = null; this.handshakeTimer = null; this.generation++; this.#closeSocket(); this.meld = null; }
  reconnectNow() { if (!this.running) this.running = true; clearTimeout(this.retryTimer); this.retryTimer = null; this.retryMs = MIN_RETRY; this.generation++; this.#closeSocket(); this.meld = null; this.#connect(); }
  #connect() {
    if (!this.running || this.ws) return;
    const generation = ++this.generation;
    this.logger.info("Connecting to Meld", { url: MELD_URL });
    let ws;
    try { ws = new WebSocket(MELD_URL); this.ws = ws; }
    catch (err) { this.logger.warn("Could not create Meld socket", { error: err.message }); this.#scheduleRetry(); return; }
    this.handshakeTimer = setTimeout(() => { if (generation !== this.generation || this.meld) return; this.logger.warn("Meld QWebChannel handshake timed out"); this.#closeSocket(); this.#scheduleRetry(); }, HANDSHAKE_TIMEOUT);
    ws.on("open", () => {
      if (generation !== this.generation) return;
      try {
        new QWebChannel(ws, channel => {
          if (generation !== this.generation) return;
          const meld = channel.objects.meld;
          if (!meld) { this.logger.warn("QWebChannel opened without a Meld object"); this.#closeSocket(); this.#scheduleRetry(); return; }
          clearTimeout(this.handshakeTimer); this.handshakeTimer = null; this.retryMs = MIN_RETRY; this.meld = meld;
          this.#wireSignals(meld, generation);
          this.logger.info("Meld connected", { apiVersion: meld.version ?? 1 });
          this.emit("connected", this.getStatus()); this.emit("resources", this.getResources());
        });
      } catch (err) { this.logger.warn("Meld QWebChannel initialization failed", { error: err.message }); this.#closeSocket(); this.#scheduleRetry(); }
    });
    ws.on("close", () => { if (generation !== this.generation) return; clearTimeout(this.handshakeTimer); this.handshakeTimer = null; this.ws = null; const wasConnected = Boolean(this.meld); this.meld = null; if (wasConnected) { this.logger.warn("Meld disconnected"); this.emit("disconnected"); } this.#scheduleRetry(); });
    ws.on("error", err => { if (generation === this.generation) this.logger.warn("Meld socket error", { error: err.message }); });
  }
  #wireSignals(meld, generation) {
    meld.sessionChanged?.connect?.(() => { if (generation !== this.generation || meld !== this.meld) return; this.emit("resources", this.getResources()); this.emit("status", this.getStatus()); });
    meld.isStreamingChanged?.connect?.(() => { if (generation === this.generation && meld === this.meld) this.emit("status", this.getStatus()); });
    meld.isRecordingChanged?.connect?.(() => { if (generation === this.generation && meld === this.meld) this.emit("status", this.getStatus()); });
    meld.gainUpdated?.connect?.((trackId, gain, muted) => { if (generation === this.generation && meld === this.meld) this.emit("gain", { trackId, gain, muted }); });
  }
  #scheduleRetry() { if (!this.running || this.retryTimer) return; const wait = this.retryMs; this.retryMs = Math.min(MAX_RETRY, Math.round(this.retryMs * 1.7)); this.retryTimer = setTimeout(() => { this.retryTimer = null; this.#connect(); }, wait); }
  #closeSocket() { const ws = this.ws; this.ws = null; if (!ws) return; try { ws.removeAllListeners("open"); ws.removeAllListeners("close"); ws.removeAllListeners("error"); ws.close(); } catch {} }
  requireMeld() { if (!this.connected) { const err = new Error("Meld Studio is not connected."); err.code = "MELD_OFFLINE"; throw err; } return this.meld; }
  getStatus() { const meld = this.meld; const resources = meld ? this.getResources() : { scenes: [] }; const currentScene = resources.scenes.find(s => s.current) || null; return { connected: this.connected, apiVersion: meld?.version ?? null, isStreaming: Boolean(meld?.isStreaming), isRecording: Boolean(meld?.isRecording), currentScene }; }
  getResources() { const items = this.meld?.session?.items || {}; const scenes = [], layers = [], tracks = [], effects = []; for (const [id, raw] of Object.entries(items)) { const item = { id, ...plainClone(raw) }; if (item.type === "scene") scenes.push(item); else if (item.type === "layer") layers.push(item); else if (item.type === "track") tracks.push(item); else if (item.type === "effect") effects.push(item); } const sort = (a, b) => (a.index ?? 9999) - (b.index ?? 9999) || String(a.name).localeCompare(String(b.name)); scenes.sort(sort); layers.sort(sort); tracks.sort(sort); effects.sort(sort); return { scenes, layers, tracks, effects }; }
}
function plainClone(value) { try { return JSON.parse(JSON.stringify(value)); } catch { return {}; } }
