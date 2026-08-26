import { EventEmitter } from "node:events";
import os from "node:os";
import WebSocket from "ws";
import { CAPABILITIES } from "./command-router.js";

const HEARTBEAT_MS = 15_000;
const MIN_RETRY = 1_000;
const MAX_RETRY = 30_000;
const MAX_SEEN_IDS = 2_000;

export class CloudClient extends EventEmitter {
  constructor({ logger, settings, meldClient, commandRouter, bridgeVersion, apiBase }) {
    super();
    this.logger = logger;
    this.settings = settings;
    this.meldClient = meldClient;
    this.commandRouter = commandRouter;
    this.bridgeVersion = bridgeVersion;
    this.apiBase = apiBase.replace(/\/+$/, "");
    this.ws = null;
    this.running = false;
    this.retryMs = MIN_RETRY;
    this.retryTimer = null;
    this.heartbeatTimer = null;
    this.seen = new Map();
    this.meldClient.on("status", () => this.sendStatus());
    this.meldClient.on("connected", () => this.sendStatus());
    this.meldClient.on("disconnected", () => this.sendStatus());
    this.meldClient.on("resources", resources => this.send({ type: "meld_resources", deviceId: this.settings.deviceId, at: now(), resources }));
  }

  get connected() { return this.ws?.readyState === WebSocket.OPEN; }

  async pair(pairingCode) {
    const code = String(pairingCode || "").trim();
    if (!/^[A-Za-z0-9-]{4,64}$/.test(code)) throw coded("BAD_PAIRING_CODE", "Enter the pairing code shown on fragbot.tech/meld.");
    assertSafeHttpBase(this.apiBase);
    const res = await fetch(`${this.apiBase}/api/bridge/v1/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairingCode: code, device: { id: this.settings.deviceId, name: os.hostname(), platform: process.platform, arch: process.arch, bridgeVersion: this.bridgeVersion } })
    });
    let body = {};
    try { body = await res.json(); } catch {}
    if (!res.ok) throw coded("PAIR_FAILED", body?.message || `Pairing failed (${res.status}).`);
    if (!body.deviceCredential || !body.websocketUrl) throw coded("PAIR_BAD_RESPONSE", "FRAGBOT pairing response is missing deviceCredential or websocketUrl.");
    assertSafeWsUrl(body.websocketUrl);
    this.settings.setPairing({ credential: body.deviceCredential, websocketUrl: body.websocketUrl, account: body.account || null });
    this.logger.info("Bridge paired", { account: body.account || null });
    this.emit("pairing", { paired: true, account: body.account || null });
    this.start();
    return { paired: true, account: body.account || null };
  }

  unpair() { this.stop(); this.settings.clearPairing(); this.emit("pairing", { paired: false, account: null }); this.logger.info("Bridge unpaired"); }
  start() { if (!this.settings.paired || this.running) return; this.running = true; this.retryMs = MIN_RETRY; this.#connect(); }
  stop() { this.running = false; clearTimeout(this.retryTimer); clearInterval(this.heartbeatTimer); this.retryTimer = null; this.heartbeatTimer = null; if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; } this.emit("connection", false); }
  reconnectNow() { this.stop(); if (this.settings.paired) this.start(); }

  #connect() {
    if (!this.running || this.connected || !this.settings.paired) return;
    const credential = this.settings.getCredential(), baseUrl = this.settings.websocketUrl;
    if (!credential || !baseUrl) return;
    let url;
    try { url = new URL(baseUrl); url.searchParams.set("deviceId", this.settings.deviceId); assertSafeWsUrl(url.toString()); }
    catch (err) { this.logger.error("Invalid FRAGBOT Bridge WebSocket URL", { error: err.message }); return; }
    this.logger.info("Connecting to FRAGBOT Cloud", { host: url.host });
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${credential}` }, handshakeTimeout: 10_000, maxPayload: 256_000 });
    this.ws = ws;
    ws.on("open", () => {
      if (this.ws !== ws) return;
      this.retryMs = MIN_RETRY; this.emit("connection", true); this.logger.info("FRAGBOT Cloud connected");
      this.send({ type: "hello", deviceId: this.settings.deviceId, bridgeVersion: this.bridgeVersion, capabilities: CAPABILITIES });
      this.sendStatus();
      this.send({ type: "meld_resources", deviceId: this.settings.deviceId, at: now(), resources: this.meldClient.getResources() });
      clearInterval(this.heartbeatTimer); this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), HEARTBEAT_MS);
    });
    ws.on("message", raw => this.#onMessage(raw));
    ws.on("close", code => { if (this.ws !== ws) return; this.ws = null; clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; this.emit("connection", false); this.logger.warn("FRAGBOT Cloud disconnected", { code }); this.#scheduleRetry(); });
    ws.on("error", err => { if (this.ws === ws) this.logger.warn("FRAGBOT Cloud socket error", { error: err.message }); });
  }

  #scheduleRetry() { if (!this.running || this.retryTimer) return; const wait = this.retryMs; this.retryMs = Math.min(MAX_RETRY, Math.round(this.retryMs * 1.8)); this.retryTimer = setTimeout(() => { this.retryTimer = null; this.#connect(); }, wait); }

  async #onMessage(raw) {
    if (Buffer.byteLength(raw) > 256_000) return;
    let msg; try { msg = JSON.parse(raw.toString("utf8")); } catch { return; }
    if (msg?.type !== "command") return;
    const started = Date.now(), id = String(msg.id || "");
    if (!id || id.length > 200) return;
    if (this.seen.has(id)) { this.send(this.seen.get(id)); return; }
    const expires = Date.parse(msg.expiresAt || "");
    if (!Number.isFinite(expires) || expires < Date.now() || expires > Date.now() + 5 * 60_000) return this.#rememberAndSend(id, resultMessage(id, false, null, "COMMAND_EXPIRED", "Command is expired or has an invalid expiration.", started));
    try { const result = await this.commandRouter.execute(String(msg.action || ""), isPlainObject(msg.args) ? msg.args : {}); this.#rememberAndSend(id, resultMessage(id, true, result, null, null, started)); }
    catch (err) { this.logger.warn("Bridge command failed", { id, action: msg.action, code: err.code, error: err.message }); this.#rememberAndSend(id, resultMessage(id, false, null, err.code || "COMMAND_FAILED", err.message || "Command failed.", started)); }
  }

  #rememberAndSend(id, message) { this.seen.set(id, message); while (this.seen.size > MAX_SEEN_IDS) this.seen.delete(this.seen.keys().next().value); this.send(message); }
  sendHeartbeat() { this.send({ type: "heartbeat", deviceId: this.settings.deviceId, at: now(), meld: this.meldClient.getStatus() }); }
  sendStatus() { this.send({ type: "status", deviceId: this.settings.deviceId, at: now(), meld: this.meldClient.getStatus() }); }
  send(value) { if (!this.connected) return false; try { this.ws.send(JSON.stringify(value)); return true; } catch { return false; } }
}

function resultMessage(id, ok, result, code, message, started) { return { type: "command_result", id, ok, ...(ok ? { result } : { error: { code, message } }), durationMs: Date.now() - started, at: now() }; }
function isPlainObject(v) { return Boolean(v && typeof v === "object" && !Array.isArray(v)); }
function now() { return new Date().toISOString(); }
function coded(code, message) { const err = new Error(message); err.code = code; return err; }
function allowInsecureLocalhost() { return process.env.FRAGBOT_ALLOW_INSECURE_LOCALHOST === "1"; }
function assertSafeHttpBase(input) { const u = new URL(input), local = ["localhost", "127.0.0.1", "::1"].includes(u.hostname); if (u.protocol !== "https:" && !(local && allowInsecureLocalhost())) throw coded("INSECURE_CLOUD_URL", "FRAGBOT cloud API must use HTTPS."); }
function assertSafeWsUrl(input) { const u = new URL(input), local = ["localhost", "127.0.0.1", "::1"].includes(u.hostname); if (u.protocol !== "wss:" && !(local && allowInsecureLocalhost())) throw coded("INSECURE_CLOUD_URL", "FRAGBOT Bridge connection must use WSS."); }
