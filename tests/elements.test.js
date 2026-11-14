// tests/elements.test.js — element factory + bbox math + schema validation.
import { test } from "node:test";
import assert from "node:assert/strict";

import { clampBBox, normalizeScriptBBox, tableToMarkdown, assignElementIds, paragraphElement } from "../src/elements.js";
import { validateElement, validateManifest } from "../src/schema.js";

test("clampBBox clamps into [0,1] and orders corners", () => {
  assert.deepEqual(clampBBox([1.5, 0.9, -0.5, 0.1]), [0, 0.1, 1, 0.9]);
  assert.deepEqual(clampBBox([0.9, 0.8, 0.1, 0.2]), [0.1, 0.2, 0.9, 0.8]);
  assert.equal(clampBBox(["x", 0, 1, 1]), null);
  assert.equal(clampBBox(null), null);
});

test("normalizeScriptBBox flips the y axis (unpdf is bottom-up)", () => {
  // A title 26pt tall sitting at unpdf y=695.6 in a 792pt-tall Letter page.
  const bbox = normalizeScriptBBox({ x: 72, y: 695.6, width: 454.66, height: 26 }, 612, 792);
  assert.equal(bbox[0], 72 / 612);
  assert.ok(Math.abs(bbox[1] - (792 - 721.6) / 792) < 1e-9);
  assert.ok(Math.abs(bbox[3] - (792 - 695.6) / 792) < 1e-9);
  assert.ok(bbox[1] < bbox[3]);
});

test("tableToMarkdown emits a header separator row", () => {
  const md = tableToMarkdown([["A", "B"], ["1", "2"]], 1);
  const lines = md.split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[1], /^\|\s*---\s*\|\s*---\s*\|$/);
});

test("assignElementIds is sequential and zero-padded", () => {
  const ids = assignElementIds([
    paragraphElement({ page: 1, bbox: [0, 0, 1, 1], text: "x", source: "script" }),
    paragraphElement({ page: 1, bbox: [0, 0, 1, 1], text: "y", source: "script" }),
  ]).map((e) => e.id);
  assert.deepEqual(ids, ["e0001", "e0002"]);
});

test("element schema: a valid paragraph validates; a table without rows fails", () => {
  const el = assignElementIds([
    paragraphElement({ page: 1, bbox: [0.1, 0.1, 0.9, 0.2], text: "hello", source: "script" }),
  ])[0];
  assert.equal(validateElement(el).ok, true);

  const badTable = {
    id: "e0001", type: "table", page: 1, bbox: [0, 0, 1, 1],
    source: "script", needs_review: false,
  };
  assert.equal(validateElement(badTable).ok, false);
});
