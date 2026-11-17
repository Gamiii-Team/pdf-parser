// tests/harden.test.js — hardening: cross-path dedup, stable ordering, vector clustering,
// and the exact-duplicate-section regression from the sample.pptx run.
// (Docker-gated like chartEnrich.test.js; skips gracefully without the converter image.)

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { dedupeCrossPathBlocks, extractDocument } from "../src/extractDocument.js";
import { buildTree } from "../src/extract/treeBuilder.js";
import { clusterVectorBoxes } from "../src/extract/textPage.js";

const dockerOk = () => {
  try { execFileSync("docker", ["image", "inspect", "pdf-parser-converter:latest", "--format", "{{.Id}}"], { stdio: "pipe" }); return true; } catch { return false; }
};

// ───────────────────────── cross-path dedup ─────────────────────────

test("twin heading from span + VLM paths collapses to one block", () => {
  const span = { type: "heading", page: 3, bbox: [50, 500, 400, 520], content: "Figure: Revenue by Month", level: 1 };
  const vlm = { type: "heading", page: 3, bbox: null, content: "Figure: Revenue by Month", level: 1 };
  const { blocks, dropped } = dedupeCrossPathBlocks([span, vlm]);
  assert.equal(dropped, 1);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].bbox, [50, 500, 400, 520], "span-derived block keeps its bbox");
});

test("dedup ORs needs_review flags and merges missing captions", () => {
  const keep = { type: "text", page: 1, bbox: [0, 10, 50, 20], content: "same prose", needs_review: false, caption: null };
  const dup = { type: "text", page: 1, bbox: null, content: "same prose", needs_review: true, caption: "Figure 1" };
  const { blocks, dropped } = dedupeCrossPathBlocks([keep, dup]);
  assert.equal(dropped, 1);
  assert.equal(blocks[0].needs_review, true, "any path flagging review wins");
  assert.equal(blocks[0].caption, "Figure 1");
});

test("dedup does not merge across types, pages, or empty content", () => {
  const { dropped } = dedupeCrossPathBlocks([
    { type: "text", page: 1, content: "same" },
    { type: "notes", page: 1, content: "same" },   // different type
    { type: "text", page: 2, content: "same" },   // different page
    { type: "text", page: 1, content: "" },       // empty — never merged
    { type: "text", page: 1, content: "different" },
  ]);
  assert.equal(dropped, 0);
});

test("chart and table blocks are never deduped", () => {
  const chart = { type: "chart", page: 3, content: { x: ["a"] }, needs_review: true };
  const { blocks, dropped } = dedupeCrossPathBlocks([chart, { ...chart }]);
  assert.equal(dropped, 0);
  assert.equal(blocks.length, 2);
});

// ───────────────────────── tree stability ─────────────────────────

test("null-bbox VLM blocks stay after span blocks on the same page", () => {
  const tree = buildTree([
    { type: "heading", page: 1, bbox: [0, 10, 100, 20], content: "A", level: 1 },
    { type: "text", page: 1, bbox: [0, 30, 100, 40], content: "span text" },
    { type: "chart", page: 1, bbox: null, content: { x: ["1"] }, needs_review: true, estimates: true },
    { type: "text", page: 1, bbox: null, content: "vlm text" },
  ]);
  assert.deepEqual(tree[0].content.map((c) => c.type), ["text", "chart", "text"]);
  assert.deepEqual(tree[0].content.map((c) => c.content).slice(1), [{ x: ["1"] }, "vlm text"]);
});

// ───────────────────────── vector clustering ─────────────────────────

test("adjacent chart parts (bars + axis) cluster into one figure region", () => {
  const boxes = [
    [60, 150, 126, 262],   // bar 1
    [165, 115, 231, 262],  // bar 2
    [270, 80, 336, 262],   // bar 3
    [44, 262, 470, 264],   // axis line
    [20, 220, 470, 220],   // gridline
  ];
  const merged = clusterVectorBoxes(boxes);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0], [20, 80, 470, 264]);
});

test("distant drawings remain separate figures", () => {
  const a = [60, 150, 126, 262];
  const b = [60, 20, 126, 40];   // header ornament, far from the bars
  const merged = clusterVectorBoxes([a, b]);
  assert.equal(merged.length, 2);
});

// ─────────── integration: the exact duplicate-section regression ───────────

const VLM_STUB = JSON.stringify({
  blocks: [
    { type: "heading", level: 1, text: "Figure: Revenue by Month" },
    { type: "chart", chart_type: "bar", title: "Revenue by Month", description: "d", content: null, estimates: false, needs_review: true, caption: "Figure: Revenue by Month" },
    { type: "text", text: "Bar chart comparing January to April revenue." },
  ],
});
const FIGURE_STUB = JSON.stringify({
  chart_type: "bar", title: "Revenue by Month", description: "d", estimates: true, needs_review: false,
  content: { title: "Revenue by Month", x: ["January", "February", "March", "April"], series: [{ name: "Revenue", values: [10, 12, 15, 14] }] },
});

function stubProvider(failPage = false) {
  return {
    async complete(messages) {
      const prompt = messages?.[0]?.content?.find((c) => c.type === "text")?.text ?? "";
      const usage = { input: 10, output: 5 };
      if (prompt.includes("document-region analyzer")) return { text: FIGURE_STUB, finishReason: "stop", usage };
      if (failPage) throw new Error("simulated VLM failure");
      return { text: VLM_STUB, finishReason: "stop", usage };
    },
  };
}
const silent = { info() {}, warn() {}, error() {} };

function findHeadings(sections, heading) {
  const hits = [];
  const walk = (list) => { for (const s of list ?? []) { if (s.heading === heading) hits.push(s); walk(s.subsections); } };
  walk(sections);
  return hits;
}

test("sample.pptx no longer produces duplicate sibling sections", async (t) => {
  if (!dockerOk()) { t.skip("converter image not built — run: docker build -t pdf-parser-converter:latest docker/converter"); return; }
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "harden-test-"));
  try {
    const { manifest, report } = await extractDocument(path.resolve("fixtures/sample.pptx"), {
      out: outDir, modelBackend: "none", provider: stubProvider(false),
      subjectDetect: false, figurePass: true, logger: silent,
    });
    assert.equal(findHeadings(manifest.sections, "Figure: Revenue by Month").length, 1, "heading must appear exactly once");
    assert.ok(report.deduped_blocks >= 1, "at least one cross-path duplicate was removed");
    assert.ok(report.validation?.figures, "report carries the figures summary");
    assert.equal(report.validation.figures.chart_blocks >= 1, true);
    // The chart must live INSIDE the single Figure section together with the caption text
    const fig = findHeadings(manifest.sections, "Figure: Revenue by Month")[0];
    const types = fig.content.map((b) => b.type);
    assert.equal(types.includes("chart"), true, "chart must be nested inside the single Figure section");
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("VLM page failure still preserves span-derived content with flagged notes + errors", async (t) => {
  if (!dockerOk()) { t.skip("converter image not built"); return; }
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "harden-fail-test-"));
  try {
    const { manifest, report } = await extractDocument(path.resolve("fixtures/sample.pptx"), {
      out: outDir, modelBackend: "none", provider: stubProvider(true),
      subjectDetect: false, figurePass: true, logger: silent,
    });
    const text = JSON.stringify(manifest.sections);
    assert.ok(text.includes("Bar chart comparing January to April revenue."), "span-derived caption survives a VLM failure");
    assert.ok(report.errors.vlm_page.length >= 1, "vlm page error is surfaced in the report");
    assert.ok(text.includes("VLM page failed"), "failure is recorded as a needs_review notes block");
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
