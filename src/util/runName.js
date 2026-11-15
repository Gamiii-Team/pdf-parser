// src/util/runName.js
// Shared, pure helpers for generating self-describing run folder names.
// Used by the CLI (via src/extractDocument.js) and the UI server (UI/server.mjs)
// so both produce the same shape:
//
//   <runId>_<inputSlug>_<backend>-<modelSlug>
//
// Example: 0b671f7bee35e952_test_groq-qwen3.8-27b
//
// Segments are joined by "_", so "_" never appears inside a segment.
// The leading runId (16 hex chars) keeps same-second runs of the same file
// collision-free and gives findRunDir() a stable prefix to match on.

import crypto from "node:crypto";

/** Lower-cased, filesystem-safe slug: unsafe chars → "-", collapsed, trimmed, truncated. */
export function slugify(input, max = 40) {
  const s = String(input ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-") // any run of disallowed chars (incl. "_") → one "-"
    .replace(/-+[.]/g, ".")       // "final-.pdf" → "final.pdf"
    .replace(/[.]-+/g, ".")       // "a.-b" → "a.b"
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, max)
    .replace(/[-.]+$/g, "");      // re-trim after truncation
  return s || "input";
}

/** Strip a trailing extension ("scan.pdf" → "scan", "test" → "test", ".pdf" → ".pdf"). */
export function stripExt(name) {
  const base = String(name ?? "").split(/[\\/]/).pop() ?? "";
  const stripped = base.replace(/\.[^.]+$/, "");
  return stripped === "" ? base : stripped;
}

/** Model id → short slug: drop org prefix (last "/" segment) and slugify. */
export function modelSlug(model, max = 40) {
  const raw = String(model ?? "").trim() || "model";
  const parts = raw.split("/").filter(Boolean);
  const last = parts.length ? parts[parts.length - 1] : raw;
  return slugify(last, max);
}

/** 16-hex run id (8 random bytes). */
export function genRunId() {
  return crypto.randomBytes(8).toString("hex");
}

/**
 * Build the run folder name (not a path).
 *   inputName original input file name (extension is stripped for the slug)
 *   backend   "groq" | "modal" | "none"
 *   model     model id as configured (org prefix is dropped automatically);
 *             pass "" when no model is active
 *   runId     16-hex id (generated if omitted)
 */
export function formatRunFolder({ inputName = "input", backend = "none", model = "", runId } = {}) {
  const id = runId ?? genRunId();
  const backendPart = model
    ? `${slugify(backend, 12)}-${modelSlug(model)}`
    : slugify(backend, 12);
  return [id, slugify(stripExt(inputName), 40), backendPart].join("_");
}
