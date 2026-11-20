// tests/translateManifest.test.js — translated English figure fields reach manifest.json.
// Pure: buildManifest from a result.json whose figures carry translated prose.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildManifest } from "../src/vlmManifest.js";

const result = (figures) => ({
  jobId: "testjob",
  subject: "Test deck",
  subject_source: "title",
  source_file: "deck.pptx",
  slides: [{
    slide: 1,
    title: "Revenue overview",
    subtitle: null,
    text_blocks: [],
    tables: [],
    figures,
    speaker_notes: null,
    confidence: "high",
    issues: [],
    reviewed: true,
  }],
});
const statuses = { 1: "approved" };

test("buildManifest uses translated English title/description/visible_text for figure blocks", () => {
  const figures = [{
    type: "chart",
    title: "Revenue by region",
    description: "A bar chart comparing quarterly revenue across four regions in English.",
    visible_text: ["Region", "Revenue", "North", "South"],
    data: { labels: ["North", "South"], series: [] },
    bbox: [0.1, 0.1, 0.8, 0.8],
    translated: true,
  }];
  const manifest = buildManifest(result(figures), statuses, [], {});
  const block = manifest.sections[0].content.find((b) => b.type === "chart");
  assert.ok(block, "figure became a chart block");
  assert.equal(block.title, "Revenue by region");
  assert.equal(block.description, "A bar chart comparing quarterly revenue across four regions in English.");
  assert.match(block.description, /bar chart|English/);
  assert.equal(block.review_status, undefined, "approved chart has no pending marker");
  assert.equal("translated" in block, false, "review-only flag is not exported into the manifest");
});

test("buildManifest leaves untranslated descriptions unchanged (no data loss)", () => {
  const figures = [{
    type: "chart",
    title: "Ingresos",
    description: "Gráfico de barras",
    visible_text: ["Región"],
    data: { labels: ["N"], series: [] },
    bbox: [0.1, 0.1, 0.8, 0.8],
  }];
  const manifest = buildManifest(result(figures), statuses, [], {});
  const block = manifest.sections[0].content.find((b) => b.type === "chart");
  assert.equal(block.description, "Gráfico de barras");
});
