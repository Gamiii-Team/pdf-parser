// tests/crop.test.js — crop builder: geometry, padding, 300 DPI cap, error paths.
// Uses test.pdf (born-digital, two pages) for real rendering. No model calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { renderFigureCrop } from "../src/crop.js";

const SRC = path.resolve("test.pdf");

test("padded crop keeps aspect ratio and stays under the pixel cap", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "crop-test-"));
  const out = path.join(tmp, "fig.png");
  const { dpi, width_px, height_px } = await renderFigureCrop(SRC, 1, [0.1, 0.1, 0.9, 0.9], out, { pad: 0.03, dpi: 300, maxDim: 2048 });
  assert.ok(fs.existsSync(out), "crop image written");
  assert.ok(Math.max(width_px, height_px) <= 2048, `longest side ${Math.max(width_px, height_px)} <= 2048`);
  assert.ok(dpi <= 300 && dpi >= 72, `dpi ${dpi} sane`);
  // 0.8 of both page dimensions → same aspect as the page (letter = 612/792)
  assert.ok(Math.abs(width_px / height_px - 612 / 792) < 0.02, `expected letter-page aspect, got ${width_px}x${height_px}`);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("maxDim smaller forces a lower dpi but keeps the box", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "crop-test2-"));
  const out = path.join(tmp, "fig.png");
  const { dpi, width_px, height_px } = await renderFigureCrop(SRC, 1, [0.0, 0.0, 1.0, 1.0], out, { pad: 0, dpi: 600, maxDim: 1000 });
  assert.ok(Math.max(width_px, height_px) <= 1000);
  assert.ok(dpi < 600);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("clamping at slide edges — box at the boundary renders fine", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "crop-test3-"));
  const out = path.join(tmp, "fig.png");
  const { width_px, height_px } = await renderFigureCrop(SRC, 1, [0.9, 0.8, 1.0, 1.0], out, { pad: 0.05, dpi: 150, maxDim: 2048 });
  assert.ok(width_px > 0 && height_px > 0);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("unknown page and empty box throw meaningful errors", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "crop-test4-"));
  await assert.rejects(renderFigureCrop(SRC, 99, [0.1, 0.1, 0.9, 0.9], path.join(tmp, "x.png")), /page 99 not found/);
  await assert.rejects(renderFigureCrop(SRC, 1, [0.5, 0.5, 0.5, 0.5], path.join(tmp, "x.png")), /crop box is empty/);
  fs.rmSync(tmp, { recursive: true, force: true });
});


