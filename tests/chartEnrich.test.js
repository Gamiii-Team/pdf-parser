// tests/chartEnrich.test.js — regression: VLM-routed chart blocks with null/flagged
// content must be re-analyzed by the figure pass, and the report must carry errors + pptx metadata.
// Skipped automatically when the converter image is not built (docker required for .pptx).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { extractDocument } from "../src/extractDocument.js";

const FIXTURE = path.resolve("fixtures/sample.pptx");

function dockerConverterAvailable() {
  try {
    execFileSync("docker", ["image", "inspect", "pdf-parser-converter:latest", "--format", "{{.Id}}"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const VLM_CHART_STUB = JSON.stringify({
  blocks: [
    { type: "heading", level: 1, text: "Figure: Revenue by Month" },
    { type: "chart", chart_type: "bar", title: null, description: null, content: null, estimates: false, needs_review: true, caption: "Figure: Revenue by Month" },
    { type: "text", text: "Bar chart comparing January to April revenue." },
  ],
});
const FIGURE_STUB = JSON.stringify({
  chart_type: "bar",
  title: "Revenue by Month",
  description: "Revenue by month, January to April, rising then dipping.",
  estimates: true,
  needs_review: false,
  content: { title: "Revenue by Month", x: ["January", "February", "March", "April"], series: [{ name: "Revenue", values: [10, 12, 15, 14] }] },
});

function makeStubProvider() {
  const calls = [];
  return {
    calls,
    async complete(messages, _opts = {}) {
      calls.push(messages);
      const prompt = messages?.[0]?.content?.find((c) => c.type === "text")?.text ?? "";
      const isFigurePrompt = prompt.includes("document-region analyzer");
      const isSubjectPrompt = prompt.includes("document subject classifier");
      const usage = { input: 100, output: 50 };
      if (isFigurePrompt) return { text: FIGURE_STUB, finishReason: "stop", usage };
      if (isSubjectPrompt) return { text: '{"subject":"quarterly sample"}', finishReason: "stop", usage };
      return { text: VLM_CHART_STUB, finishReason: "stop", usage };
    },
  };
}

test("flagged VLM chart block gets enriched by the figure pass (regression)", async (t) => {
  if (!dockerConverterAvailable()) {
    t.skip("converter image pdf-parser-converter:latest not built — run: docker build -t pdf-parser-converter:latest docker/converter");
    return;
  }
  const provider = makeStubProvider();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "chart-enrich-test-"));
  const { manifest, report } = await extractDocument(FIXTURE, {
    out: outDir,
    modelBackend: "none",
    provider,
    subjectDetect: true,
    figurePass: true,
    logger: { info() {}, warn() {}, error() {} },
  });

  try {
    // The chart block must carry the enriched content, not null
    const findChart = (s) => {
      for (const b of s.content ?? []) if (b.type === "chart") return b;
      for (const sub of s.subsections ?? []) { const hit = findChart(sub); if (hit) return hit; }
      return null;
    };
    let chart = null;
    for (const s of manifest.sections) { chart = chart ?? findChart(s); }
    assert.ok(chart, "chart block missing from manifest");
    assert.equal(chart.chart_type, "bar");
    assert.equal(chart.title, "Revenue by Month");
    assert.deepEqual(chart.content?.series?.[0]?.values, [10, 12, 15, 14]);
    assert.equal(chart.estimates, true);
    assert.equal(chart.needs_review, false);

    // Report must carry figure_pass count, errors block, and pptx transparency
    assert.equal(report.figure_blocks, 1, "one flagged chart block was enriched");
    assert.equal(report.pptx?.total, 5, "3 visible + 1 hidden + 1 empty");
    assert.equal(report.pptx?.visible, 3);
    assert.equal(report.pptx?.hidden, 1);
    assert.equal(report.pptx?.empty, 1);
    assert.deepEqual(report.errors, { vlm_page: [], figure_pass: [], subject: [] });

    // The figure pass must have been invoked with an image (the chart crop)
    const figureCall = provider.calls.find((msgs) => (msgs?.[0]?.content?.find((c) => c.type === "text")?.text ?? "").includes("document-region analyzer"));
    assert.ok(figureCall, "figure analyzer was never called");
    assert.ok(figureCall[0].content.some((c) => c.type === "image_url" && String(c.image_url?.url).startsWith("data:image/jpeg;base64,")), "figure pass must receive an image crop");

    assert.equal(manifest.pages, 3, "hidden and empty slides are excluded");
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("flagged chart block with failing figure pass keeps needs_review and surfaces the error", async (t) => {
  if (!dockerConverterAvailable()) {
    t.skip("converter image pdf-parser-converter:latest not built");
    return;
  }
  const provider = makeStubProvider();
  const failingFigure = JSON.stringify({ chart_type: "bar", title: null, description: null, content: null, estimates: false, needs_review: true });
  // Make figure calls "succeed" but return content:null — chart must stay needs_review:true
  provider.complete = async (messages, _opts = {}) => {
    const prompt = messages?.[0]?.content?.find((c) => c.type === "text")?.text ?? "";
    const usage = { input: 100, output: 50 };
    if (prompt.includes("document-region analyzer")) return { text: failingFigure, finishReason: "stop", usage };
    return { text: VLM_CHART_STUB, finishReason: "stop", usage };
  };
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "chart-enrich-fail-test-"));
  const { report } = await extractDocument(FIXTURE, {
    out: outDir,
    modelBackend: "none",
    provider,
    subjectDetect: false,
    figurePass: true,
    logger: { info() {}, warn() {}, error() {} },
  });
  fs.rmSync(outDir, { recursive: true, force: true });

  // Enrichment ran, returned null content → block stays needs_review (not silently dropped)
  assert.equal(report.figure_blocks, 1);
  assert.ok(Array.isArray(report.errors?.figure_pass));
});
