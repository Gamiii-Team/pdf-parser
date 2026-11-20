// tests/labels.test.js — descriptive review labels (UI/js/labels.js).

import { test } from "node:test";
import assert from "node:assert/strict";

import { categorizeIssue, summarizeSlide, badgeLabels, figureNoteLabel } from "../UI/js/labels.js";

test("categorizeIssue maps known reason shapes to short labels", () => {
  assert.equal(categorizeIssue("slide analysis failed: schema validation failed: figures[0] …").short, "VLM analysis failed");
  assert.equal(categorizeIssue("figure_pass_failed: provider 500").short, "figure pass failed");
  assert.equal(categorizeIssue("figure value 12 not present in native chart data ([10,20])").short, "value not in native chart data");
  assert.equal(categorizeIssue("zoom: 2 tile(s) unreadable").short, "zoom tiles unreadable");
  assert.equal(categorizeIssue("native hints unavailable or misaligned (visible slides=3, pdf pages=4) — using image + text layer only").short, "native hints misaligned");
  assert.equal(categorizeIssue("something entirely new").short, "issue");
});

test("summarizeSlide flags failed / low / issues with details", () => {
  const slide = {
    slide: 4,
    failed: true,
    confidence: "low",
    issues: [
      "figure value 99 not present in native chart data ([10,20,30])",
      "figure value 100 not present in native chart data ([10,20,30])",
    ],
  };
  const sum = summarizeSlide(slide);
  assert.equal(sum.failed.short, "value not in native chart data");
  assert.equal(sum.low.short, "low confidence · 2 value mismatches");
  assert.equal(sum.issues.length, 2);
  assert.equal(sum.issues[0].detail, slide.issues[0]);
});

test("summarizeSlide tolerates clean / empty / null slides", () => {
  assert.deepEqual(summarizeSlide({ confidence: "high", issues: [] }), { failed: null, low: null, issues: [] });
  assert.deepEqual(summarizeSlide(null), { failed: null, low: null, issues: [] });
  assert.equal(summarizeSlide({ failed: true }).failed.detail, "slide failed without a recorded reason");
  assert.equal(summarizeSlide({ confidence: "low" }).low.detail, "model marked this slide low confidence");
});

test("badgeLabels emits rail badges with tooltips", () => {
  const badges = badgeLabels({ failed: true, confidence: "low", issues: ["zoom: 1 tile(s) unreadable"] });
  assert.equal(badges.length, 3);
  assert.match(badges[0].text, /^✕ /);
  assert.equal(badges[0].cls, "badge failed");
  assert.equal(badges[2].text, "⚠ 1 issue");
  assert.equal(badges[2].title, "zoom: 1 tile(s) unreadable");
  assert.equal(badgeLabels({}).length, 0);
});

test("figureNoteLabel decodes per-figure notes", () => {
  const fl = figureNoteLabel("figure_pass_failed: provider 500");
  assert.equal(fl.short, "figure pass failed");
  assert.equal(fl.detail, "figure_pass_failed: provider 500");
  assert.equal(figureNoteLabel(""), null);
  assert.equal(figureNoteLabel(undefined), null);
});
