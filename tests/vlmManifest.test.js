// tests/vlmManifest.test.js — manifest built from the merged/reviewed slide state.
// No Groq calls; deterministic pure-function tests plus mergeSlides keepBox semantics.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildManifest } from "../src/vlmManifest.js";
import { mergeSlides } from "../src/mergeMain.js";

const mkSlide = (n, overrides = {}) => ({
  slide: n, title: `Slide ${n}`, subtitle: null,
  text_blocks: [{ text: `Block ${n}`, role: "body", level: 0 }],
  tables: [], figures: [],
  speaker_notes: null, confidence: "high", issues: [],
  ...overrides,
});

const mkResult = (slides) => ({
  jobId: "job_test_001", mode: "vlm", model: "m", backend: "groq",
  input: "deck.pptx", source_file: "/abs/deck.pptx",
  subject: "unknown", subject_source: "unavailable", created: 123,
  slides,
});

const figure = (overrides = {}) => ({
  type: "chart", title: "Revenue", description: "First-pass description.",
  data: { labels: ["Jan", "Feb"], series: [] },
  visible_text: ["Revenue", "Jan", "Feb"],
  ...overrides,
});

test("buildManifest: approved slide — no pending markers, needs_review cleared, edits visible", () => {
  const result = mkResult([mkSlide(1, { figures: [figure({ description: "Reviewed description." })] })]);
  const statuses = { 1: "approved" };
  const manifest = buildManifest(result, statuses, null);
  const chart = manifest.sections[0].content.find((b) => b.type === "chart");
  assert.equal(chart.description, "Reviewed description.");
  assert.equal(chart.needs_review, false);
  assert.equal(chart.review_status, undefined);
  assert.equal(manifest.id, "doc_vlm_job_test_001");
  assert.equal(manifest.source_file, "/abs/deck.pptx");
  assert.equal(manifest.pages, 1);
});

test("buildManifest: pending slide — table/chart blocks marked pending; needs_review kept for low confidence", () => {
  const result = mkResult([mkSlide(1, {
    confidence: "low",
    tables: [{ headers: ["a"], rows: [["1"]] }],
    figures: [figure()],
  })]);
  const statuses = { 1: "queued" };
  const manifest = buildManifest(result, statuses, null);
  const table = manifest.sections[0].content.find((b) => b.type === "table");
  const chart = manifest.sections[0].content.find((b) => b.type === "chart");
  assert.equal(table.review_status, "pending");
  assert.equal(chart.review_status, "pending");
  assert.equal(chart.needs_review, true);
});

test("buildManifest: pending slide with native series + high confidence — needs_review false but still pending", () => {
  const result = mkResult([mkSlide(1, {
    confidence: "high",
    figures: [figure({ data: { labels: ["Q1"], series: [{ name: "rev", values: [10] }] } })],
  })]);
  const statuses = { 1: "queued" };
  const manifest = buildManifest(result, statuses, null);
  const chart = manifest.sections[0].content.find((b) => b.type === "chart");
  assert.equal(chart.needs_review, false);
  assert.equal(chart.review_status, "pending");
});

test("buildManifest: excluded (not-a-figure) figures are dropped from the manifest entirely", () => {
  const result = mkResult([mkSlide(1, {
    figures: [
      figure({ title: "Keep me" }),
      figure({ title: "Not a figure", excluded: true }),
    ],
  })]);
  const statuses = { 1: "queued" };
  const manifest = buildManifest(result, statuses, null);
  const charts = manifest.sections[0].content.filter((b) => b.type === "chart");
  assert.equal(charts.length, 1);
  assert.equal(charts[0].title, "Keep me");
});

test("mergeSlides keepBox: bbox and bbox_source survive; lock/notes/excluded are dropped", () => {
  const result = mkResult([mkSlide(1, {
    figures: [figure({ bbox: [0.1, 0.1, 0.9, 0.9], bbox_source: "reviewer", bbox_locked: true, reviewer_note: "n" })],
  })]);
  const statuses = { 1: "approved" };
  const merged = mergeSlides(result, statuses, { keepBox: true });
  const fig = merged.slides[0].figures[0];
  assert.deepEqual(fig.bbox, [0.1, 0.1, 0.9, 0.9]);
  assert.equal(fig.bbox_source, "reviewer");
  assert.equal(fig.bbox_locked, undefined);
  assert.equal(fig.reviewer_note, undefined);
  assert.equal(fig.previous, undefined);
  // default (main.json semantics): boxes are gone too
  const mergedNoBox = mergeSlides(result, statuses);
  assert.equal(mergedNoBox.slides[0].figures[0].bbox, undefined);
});

test("buildManifest: failed slides become a needs_review note block, not a chart", () => {
  const result = mkResult([{ slide: 1, failed: true, issues: ["groq exploded"], confidence: "low" }]);
  const statuses = { 1: "failed" };
  const manifest = buildManifest(result, statuses, null);
  const section = manifest.sections[0];
  assert.match(section.heading, /analysis failed/);
  assert.equal(section.content.length, 1);
  assert.equal(section.content[0].type, "notes");
  assert.equal(section.content[0].needs_review, true);
  assert.equal(section.content[0].content, "groq exploded");
});

test("buildManifest: bullet runs are grouped into a list block; heading and notes carry through", () => {
  const result = mkResult([mkSlide(1, {
    subtitle: "sub",
    text_blocks: [
      { text: "Heading1", role: "heading", level: 0 },
      { text: "a", role: "bullet", level: 0 },
      { text: "b", role: "bullet", level: 0 },
      { text: "tail", role: "body", level: 0 },
    ],
    speaker_notes: "talk track",
  })]);
  const statuses = { 1: "auto" };
  const manifest = buildManifest(result, statuses, null);
  const types = manifest.sections[0].content.map((b) => b.type);
  assert.deepEqual(types, ["text", "heading", "list", "text", "notes"]);
  const list = manifest.sections[0].content.find((b) => b.type === "list");
  assert.deepEqual(list.items, ["a", "b"]);
});

test("buildManifest: native hint charts give native chart_type and native bbox fallback", () => {
  const result = mkResult([mkSlide(1, { figures: [figure({ bbox: undefined, bbox_source: undefined })] })]);
  const statuses = { 1: "queued" };
  const hints = [{ slide: 1, charts: [{ chart_type: "BAR_CLUSTERED", bbox: [0.05, 0.5, 0.95, 0.95], title: "Native Title" }] }];
  const manifest = buildManifest(result, statuses, hints);
  const chart = manifest.sections[0].content.find((b) => b.type === "chart");
  assert.equal(chart.chart_type, "bar");
  assert.equal(chart.bbox_source, "native");
  assert.deepEqual(chart.bbox, [0.05, 0.5, 0.95, 0.95]);
  assert.equal(chart.title, "Revenue"); // figure title wins over native title
});

test("buildManifest: deterministic across repeated builds (same inputs → identical bytes)", () => {
  const result = mkResult([
    mkSlide(1, { figures: [figure({ bbox: [0.1, 0.1, 0.9, 0.9], bbox_source: "model" })] }),
    mkSlide(2),
  ]);
  const statuses = { 1: "approved", 2: "auto" };
  const a = JSON.stringify(buildManifest(result, statuses, null));
  const b = JSON.stringify(buildManifest(result, statuses, null));
  assert.equal(a, b);
});

test("buildManifest: source_file falls back to basename when absent from stored result", () => {
  const result = mkResult([mkSlide(1)]);
  delete result.source_file;
  const manifest = buildManifest(result, { 1: "auto" }, null);
  assert.equal(manifest.source_file, "deck.pptx");
});
