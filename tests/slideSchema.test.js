// tests/slideSchema.test.js — per-slide JSON schema validation + native cross-check.

import { test } from "node:test";
import assert from "node:assert/strict";

import { validateSlide, crossCheckSlide } from "../src/validate/slideSchema.js";

const good = {
  slide: 2,
  title: "Monthly Figures",
  subtitle: null,
  text_blocks: [{ text: "Revenue grew", role: "body", level: 0 }],
  tables: [{ headers: ["Month", "Revenue"], rows: [["January", "10"]] }],
  figures: [
    {
      type: "chart",
      title: "Rev",
      description: "Two bars.",
      data: { labels: ["a", "b"], series: [{ name: "Rev", values: [10, 12] }] },
      visible_text: [],
    },
  ],
  speaker_notes: "n",
  confidence: "high",
  issues: [],
};

test("a well-formed slide passes", () => {
  assert.equal(validateSlide(good, { expectedSlide: 2 }).ok, true);
});

test("missing/invalid required fields fail", () => {
  assert.equal(validateSlide(null).ok, false);
  assert.equal(validateSlide({ slide: 0 }).ok, false);
  assert.equal(validateSlide({ ...good, slide: 3 }, { expectedSlide: 2 }).ok, false);
  assert.equal(validateSlide({ ...good, confidence: "maybe" }).ok, false);
  assert.equal(validateSlide({ ...good, title: 42 }).ok, false);
});

test("text_blocks roles are restricted", () => {
  assert.equal(validateSlide({ ...good, text_blocks: [{ text: "x", role: "poetic" }] }).ok, false);
  assert.equal(validateSlide({ ...good, text_blocks: [{ text: "", role: "body" }] }).ok, false);
  assert.equal(validateSlide({ ...good, text_blocks: [{ text: "x", role: "bullet", level: 1 }] }).ok, true);
});

test("tables need headers and string-grid rows", () => {
  assert.equal(validateSlide({ ...good, tables: [{ headers: ["a"], rows: [["b", 4]] }] }).ok, false);
  assert.equal(validateSlide({ ...good, tables: [{ headers: ["a", "b"], rows: [["1", "2"]] }] }).ok, true);
});

test("figures must be typed and have a description", () => {
  assert.equal(validateSlide({ ...good, figures: [{ type: "chart", description: "" }] }).ok, false);
  assert.equal(validateSlide({ ...good, figures: [{ type: "hologram", description: "x" }] }).ok, false);
  assert.equal(validateSlide({ ...good, figures: [{ ...good.figures[0], data: { series: [{ name: "s", values: ["1"] }] } }] }).ok, false);
});

test("cross-check: values matching native hints keep confidence", () => {
  const hint = { charts: [{ series: [{ name: "Rev", values: [10, 12, 15, 14] }] }] };
  assert.equal(crossCheckSlide(good, hint).confidence, "high");
});

test("cross-check: injected numbers downgrade confidence and flag", () => {
  const hint = { charts: [{ series: [{ name: "Rev", values: [10, 12, 15, 14] }] }] };
  const bad = { ...good, figures: [{ ...good.figures[0], data: { series: [{ name: "Rev", values: [10, 999] }] } }] };
  const out = crossCheckSlide(bad, hint);
  assert.equal(out.confidence, "low");
  assert.equal(out.issues.length >= 1, true);
});

test("cross-check: absent hints leave confidence alone", () => {
  assert.equal(crossCheckSlide(good, null).confidence, "high");
});

// ─────────────── bounding boxes (reviewer editable, native/model/reviewer) ───────────────

test("bbox: values must be finite, ordered and non-trivial", () => {
  const mk = (bbox) => ({ ...good, figures: [{ ...good.figures[0], bbox }] });
  assert.equal(validateSlide(mk([0.1, 0.1, 0.9, 0.9])).ok, true);
  assert.equal(validateSlide(mk([0.9, 0.1, 0.1, 0.9])).ok, false, "x0 > x1 rejected");
  assert.equal(validateSlide(mk([0.1, 0.9, 0.9, 0.1])).ok, false, "y0 > y1 rejected");
  assert.equal(validateSlide(mk([0.5, 0.5, 0.501, 0.9])).ok, false, "sub-2% width rejected");
  assert.equal(validateSlide(mk([0.5, 0.5, 0.9, 0.501])).ok, false, "sub-2% height rejected");
  assert.equal(validateSlide(mk([-0.1, 0.1, 0.9, 0.9])).ok, false, "out of range rejected");
  assert.equal(validateSlide(mk([0.1, 0.1, 1.1, 0.9])).ok, false, "out of range rejected");
});

test("bbox_source and bbox_locked are validated", () => {
  const mk = (extra) => ({ ...good, figures: [{ ...good.figures[0], ...extra }] });
  assert.equal(validateSlide(mk({ bbox: [0.1, 0.1, 0.9, 0.9], bbox_source: "reviewer", bbox_locked: true })).ok, true);
  assert.equal(validateSlide(mk({ bbox: [0.1, 0.1, 0.9, 0.9], bbox_source: "alien" })).ok, false);
  assert.equal(validateSlide(mk({ bbox: [0.1, 0.1, 0.9, 0.9], bbox_locked: "yes" })).ok, false);
});

test("structure list is free-form strings when present", () => {
  const mk = (structure) => ({ ...good, figures: [{ ...good.figures[0], structure }] });
  assert.equal(validateSlide(mk(["problem area", "solution", "roadmap"])).ok, true);
  assert.equal(validateSlide(mk([1, 2])).ok, false);
  assert.equal(validateSlide(mk("not an array")).ok, false);
});

test("a reviewer box round-trips through PUT-grade validation", () => {
  const slide = { ...good, figures: [{ ...good.figures[0], bbox: [0.075, 0.248, 0.6, 0.685], bbox_source: "reviewer", bbox_locked: true }] };
  const { ok, errors } = validateSlide(slide, { expectedSlide: good.slide });
  assert.equal(ok, true, errors.join("; "));
});
