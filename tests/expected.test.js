// tests/expected.test.js — structural regression vs fixtures/expected-manifest.json
// Runs the offline pipeline (no model calls) and compares the tree shape.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractDocument } from "../src/extractDocument.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const TEST_PDF = path.join(REPO, "test.pdf");
const EXPECTED = JSON.parse(fs.readFileSync(path.join(REPO, "fixtures", "expected-manifest.json"), "utf8"));

function simp(n) {
  if (Array.isArray(n)) return n.map(simp);
  if (n && typeof n === "object") {
    const out = {};
    for (const [k, v] of Object.entries(n)) {
      if (k === "id" || k === "bbox" || k === "source_file") continue;
      out[k] = simp(v);
    }
    return out;
  }
  return n;
}

test("offline run on test.pdf matches fixtures/expected-manifest.json", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "expected-test-"));
  const { manifest } = await extractDocument(TEST_PDF, { out: outDir, figurePass: false, subjectDetect: false, modelBackend: "none" });
  assert.deepEqual(simp(manifest), EXPECTED);
});
