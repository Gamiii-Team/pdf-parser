// src/util/cache.js
// File-based cache for model call results. Keyed by content hash + mode +
// model + prompt version so reruns don't repeat paid calls.

import fs from "node:fs";
import path from "node:path";
import { sha256String } from "./hash.js";

export class FileCache {
  /**
   * @param {string} dir cache root (created lazily)
   */
  constructor(dir) {
    this.dir = dir;
  }

  _key(parts) {
    return sha256String(parts.join("\x00"));
  }

  _fileFor(key) {
    return path.join(this.dir, key.slice(0, 2), `${key}.json`);
  }

  /** @returns {any|null} parsed cached value or null on miss */
  get(parts) {
    try {
      const file = this._fileFor(this._key(parts));
      return JSON.parse(fs.readFileSync(file, "utf8")).value;
    } catch {
      return null;
    }
  }

  set(parts, value) {
    const key = this._key(parts);
    const file = this._fileFor(key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Write-then-rename for atomicity.
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ key, saved_at: new Date().toISOString(), value }, null, 2));
    fs.renameSync(tmp, file);
  }
}
