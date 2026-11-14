// src/util/hash.js
import crypto from "node:crypto";
import fs from "node:fs";

export function sha256Buffer(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function sha256File(path) {
  return sha256Buffer(fs.readFileSync(path));
}

export function sha256String(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export function stableId(...parts) {
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 12);
}
