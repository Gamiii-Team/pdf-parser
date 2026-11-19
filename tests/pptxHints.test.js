// tests/pptxHints.test.js — native hints extractor tests.
// Requires the hints image: docker build -t pdf-parser-hints -f docker/hints/Dockerfile .

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

import { extractHints } from "../src/input/pptxHints.js";

const dockerOk = () => {
  try { execFileSync("docker", ["image", "inspect", "pdf-parser-hints:latest", "--format", "{{.Id}}"], { stdio: "pipe" }); return true; } catch { return false; }
};

test("hints: fixture deck yields exact table cells, notes, hidden/empty markers", async (t) => {
  if (!dockerOk()) { t.skip("hints image not built — docker build -t pdf-parser-hints -f docker/hints/Dockerfile ."); return; }
  const { hints, ok } = await extractHints("fixtures/sample.pptx", { logger: { info() {}, warn() {} } });
  assert.equal(ok, true);
  assert.equal(hints.length, 5);

  const bySlide = Object.fromEntries(hints.map((h) => [h.slide, h]));
  assert.equal(bySlide[2].hidden, false);
  assert.equal(bySlide[2].empty, false);
  assert.deepEqual(bySlide[2].tables[0].rows[0], ["Month", "Revenue", "Costs", "Profit"]);
  assert.deepEqual(bySlide[2].tables[0].rows[4], ["April", "14", "8", "6"]);
  assert.deepEqual(bySlide[2].tables[0].bbox, [0.075, 0.306212, 0.925, 0.656168]);
  assert.match(bySlide[2].notes, /margins review/);

  assert.equal(bySlide[3].pictures.length, 1);
  assert.deepEqual(bySlide[3].pictures[0].bbox, [0.075, 0.247886, 0.599934, 0.685331]);
  for (const h of hints) {
    for (const list of [h.pictures ?? [], h.tables ?? [], h.charts ?? [], h.groups ?? []]) {
      for (const entry of list) {
        if (!entry.bbox) continue;
        const [x0, y0, x1, y1] = entry.bbox;
        assert.ok(x0 >= 0 && x1 <= 1 && y0 >= 0 && y1 <= 1, "bbox within slide");
        assert.ok(x1 > x0 && y1 > y0, "bbox has positive area");
      }
    }
  }

  assert.equal(bySlide[4].hidden, true, "hidden slide must be marked");
  assert.equal(bySlide[5].empty, true, "empty slide must be marked");
  assert.equal(bySlide[1].title, null, "fixture title shapes are not title placeholders (null is correct)");
});

test("hints: garbage input returns [] and never throws", async (t) => {
  if (!dockerOk()) { t.skip("hints image not built"); return; }
  const { hints, ok } = await extractHints("/dev/null", { logger: { info() {}, warn() {} } });
  assert.equal(ok, false);
  assert.deepEqual(hints, []);
});

test("hints: missing file returns [] without throwing", async () => {
  const { hints, ok } = await extractHints("/tmp/does-not-exist-12345.pptx", { logger: { info() {}, warn() {} } });
  assert.equal(ok, false);
  assert.deepEqual(hints, []);
});

test("hints: hidden flag respects show=\"0\" but does not apply to other slides", async (t) => {
  if (!dockerOk()) { t.skip("hints image not built"); return; }
  const { hints } = await extractHints("fixtures/sample.pptx", { logger: { info() {}, warn() {} } });
  const hidden = hints.filter((h) => h.hidden).map((h) => h.slide);
  assert.deepEqual(hidden, [4]);
});

test("validator: sample.pptx passes unchanged (5 slides, 3 effective)", async () => {
  const { validatePptx } = await import("../src/input/pptxValidate.js");
  const r = await validatePptx("fixtures/sample.pptx");
  assert.equal(r.slides, 3);
});
