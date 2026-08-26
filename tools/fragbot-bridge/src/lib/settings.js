import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export class SettingsStore {
  constructor({ userDataDir, safeStorage }) {
    this.file = path.join(userDataDir, "bridge-settings.json");
    this.safeStorage = safeStorage;
    this.data = this.#load();
    if (!this.data.deviceId) {
      this.data.deviceId = crypto.randomUUID();
      this.#save();
    }
  }

  #load() {
    try { return JSON.parse(fs.readFileSync(this.file, "utf8")); }
    catch { return {}; }
  }

  #save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), "utf8");
  }

  get deviceId() { return this.data.deviceId; }
  get account() { return this.data.account || null; }
  get websocketUrl() { return this.data.websocketUrl || null; }
  get paired() { return Boolean(this.data.credentialEncrypted); }

  setPairing({ credential, websocketUrl, account }) {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error("Windows secure storage is not available.");
    }
    this.data.credentialEncrypted = this.safeStorage.encryptString(credential).toString("base64");
    this.data.websocketUrl = websocketUrl;
    this.data.account = account || null;
    this.#save();
  }

  getCredential() {
    if (!this.data.credentialEncrypted) return null;
    if (!this.safeStorage.isEncryptionAvailable()) return null;
    const buf = Buffer.from(this.data.credentialEncrypted, "base64");
    return this.safeStorage.decryptString(buf);
  }

  clearPairing() {
    delete this.data.credentialEncrypted;
    delete this.data.websocketUrl;
    delete this.data.account;
    this.#save();
  }
}
