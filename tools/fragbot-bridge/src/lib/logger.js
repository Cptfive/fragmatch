import fs from "node:fs";
import path from "node:path";

export class Logger {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "bridge.log");
    this.listeners = new Set();
  }

  onLine(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #write(level, message, meta) {
    const safeMeta = sanitize(meta);
    const line = JSON.stringify({
      at: new Date().toISOString(),
      level,
      message,
      ...(safeMeta === undefined ? {} : { meta: safeMeta })
    });
    try {
      fs.appendFileSync(this.file, line + "\n", "utf8");
      const stat = fs.statSync(this.file);
      if (stat.size > 2_000_000) {
        const text = fs.readFileSync(this.file, "utf8");
        fs.writeFileSync(this.file, text.slice(-1_000_000), "utf8");
      }
    } catch {}
    for (const fn of this.listeners) {
      try { fn(line); } catch {}
    }
    console.log(`[${level}] ${message}`);
  }

  info(message, meta) { this.#write("info", message, meta); }
  warn(message, meta) { this.#write("warn", message, meta); }
  error(message, meta) { this.#write("error", message, meta); }
}

function sanitize(value, depth = 0) {
  if (value === undefined || depth > 5) return undefined;
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    if (typeof value === "string" && value.length > 500) return value.slice(0, 500) + "…";
    return value;
  }
  if (Array.isArray(value)) return value.slice(0, 30).map(v => sanitize(v, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/token|credential|authorization|secret|password/i.test(k)) out[k] = "[REDACTED]";
      else out[k] = sanitize(v, depth + 1);
    }
    return out;
  }
  return String(value);
}
