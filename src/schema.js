// src/schema.js
// Ajv validation against the JSON Schemas in ../schemas/. Schemas are the
// source of truth; manifest validation + the completeness check gate the
// final output.

import Ajv2020 from "ajv/dist/2020.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "schemas");

const SCHEMA_FILES = [
  "element.schema.json",
  "chunk.schema.json",
  "manifest.schema.json",
  "raw-element.schema.json",
  "raw-page-response.schema.json",
];

const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
for (const file of SCHEMA_FILES) {
  ajv.addSchema(JSON.parse(fs.readFileSync(path.join(DIR, file), "utf8")));
}

export function formatAjvErrors(errors) {
  if (!errors || errors.length === 0) return "unknown validation error";
  return errors
    .slice(0, 12)
    .map((e) => `${e.instancePath || "/"} ${e.message}`.trim())
    .join("; ");
}

export function validateRawPageElement(el) {
  const ok = ajv.validate("raw-element.schema.json", el);
  return { ok, errors: ok ? [] : formatAjvErrors(ajv.errors) };
}

export function validateRawPageResponse(resp) {
  const ok = ajv.validate("raw-page-response.schema.json", resp);
  return { ok, errors: ok ? [] : formatAjvErrors(ajv.errors) };
}

export function validateElement(el) {
  const ok = ajv.validate("element.schema.json", el);
  return { ok, errors: ok ? [] : formatAjvErrors(ajv.errors) };
}

export function validateManifest(manifest) {
  const ok = ajv.validate("manifest.schema.json", manifest);
  return { ok, errors: ok ? [] : formatAjvErrors(ajv.errors) };
}
