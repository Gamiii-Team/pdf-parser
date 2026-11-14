// tests/chunker.test.js — synthetic-document tests for the shared chunker.
import { test } from "node:test";
import assert from "node:assert/strict";

import { chunkDocument, findMissingElementIds, CompletenessError } from "../src/chunker.js";
import { assignElementIds, paragraphElement, headingElement, tableElement, figureElement, captionElement, listElement } from "../src/elements.js";
import { stitchElements } from "../src/stitch.js";
import { elementTokenEstimate } from "../src/util/token.js";

const bbox = [0.1, 0.1, 0.9, 0.2];
const para = (page, text, source = "script") =>
  paragraphElement({ page, bbox, text, source });
const heading = (page, text, level = 2) =>
  headingElement({ page, bbox, text, level, source: "script" });
const bigText = (n) => Array.from({ length: n }, (_, i) => `Sentence number ${i + 1} is here to add tokens to this paragraph.`).join(" ");

function withIds(elements) {
  return assignElementIds(elements);
}

test("every element ends up in exactly one chunk (completeness)", () => {
  const elements = withIds([
    heading(1, "Introduction", 1),
    para(1, "Short intro paragraph."),
    heading(1, "Methods", 2),
    para(1, "Method details."),
    para(2, "Methods continued on page two."),
  ]);
  const { chunks } = chunkDocument(elements, { maxTokens: 800, minTokens: 1 });
  const seen = chunks.flatMap((c) => c.elements.map((e) => e.id));
  assert.equal(seen.length, new Set(seen).size, "no element appears twice");
  assert.equal(seen.length, elements.length, "all elements appear");
});

test("chunk respects the maxTokens bound at element boundaries", () => {
  const elements = withIds([
    heading(1, "Big section", 1),
    ...Array.from({ length: 12 }, (_, i) => para(1, bigText(10) + ` (para ${i})`)),
  ]);
  const { chunks } = chunkDocument(elements, { maxTokens: 120, minTokens: 1 });
  for (const c of chunks) {
    assert.ok(c.token_estimate <= 120 || c.elements.length === 1,
      `chunk ${c.id} exceeds max (${c.token_estimate}) with more than one element`);
  }
  assert.ok(chunks.length > 1);
});

test("headings define section boundaries and TOC", () => {
  const elements = withIds([
    heading(1, "Top", 1),
    para(1, "Body under top."),
    heading(1, "Second", 1),
    para(1, "Body under second."),
  ]);
  const { chunks, toc } = chunkDocument(elements, { maxTokens: 800, minTokens: 1 });
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].section_path.join(">"), "Top");
  assert.equal(chunks[1].section_path.join(">"), "Second");
  assert.deepEqual(toc.map((t) => t.title), ["Top", "Second"]);
  assert.ok(toc.every((t) => t.chunk_ids.length === 1));
});

test("nesting builds section_path across levels", () => {
  const elements = withIds([
    heading(1, "Guide", 1),
    heading(1, "Setup", 2),
    para(1, "Install it."),
    heading(1, "Usage", 2),
    para(1, "Use it."),
  ]);
  const { chunks } = chunkDocument(elements, { maxTokens: 800, minTokens: 1 });
  const usage = chunks.find((c) => c.section_path.at(-1) === "Usage");
  assert.deepEqual(usage.section_path, ["Guide", "Usage"]);
});

test("a caption is never separated from its figure", () => {
  const elements = withIds([
    heading(1, "Charts", 1),
    figureElement({ page: 1, bbox, figure_type: "bar_chart", description: "A bar chart", caption: null, source: "script" }),
    captionElement({ page: 1, bbox, text: "Figure 1: Revenue by month", source: "script" }),
  ]);
  elements[1].atomic_group = "ag-test";
  elements[2].atomic_group = "ag-test";
  const { chunks } = chunkDocument(elements, { maxTokens: 800, minTokens: 1 });
  for (const c of chunks) {
    const hasFigure = c.elements.some((e) => e.type === "figure");
    const hasCaption = c.elements.some((e) => e.type === "caption");
    assert.equal(hasFigure, hasCaption, `figure/caption split across chunks in ${c.id}`);
  }
});

test("an oversized table is split by row groups with header repeated and continues links", () => {
  const rows = [
    ["Month", "Revenue ($K)", "Costs ($K)", "Profit ($K)"],
    ...Array.from({ length: 40 }, (_, i) => [`Month ${i + 1} very long cell content here`, `${100 + i}`, `${50 + i}`, `${50 + i}`]),
  ];
  const elements = [
    heading(1, "Data", 1),
    tableElement({ page: 1, bbox, rows, header_rows: 1, caption: null, source: "script" }),
  ];
  const stitched = stitchElements(elements, { maxTokens: 120 });
  const continued = stitched.filter((e) => e.type === "table");
  assert.ok(continued.length >= 2, `expected the oversized table to be split, got ${continued.length} part(s)`);
  assert.ok(continued[0].continues_to, "first part links to the next");
  assert.ok(continued[1].continues_from, "second part links back");
  const { chunks, stats } = chunkDocument(stitched, { maxTokens: 120, minTokens: 1 });
  const tableChunks = chunks.filter((c) => c.elements.some((e) => e.type === "table"));
  assert.ok(tableChunks.length >= 2, "table should be split across chunks");
  for (const c of tableChunks) {
    const t = c.elements.find((e) => e.type === "table");
    assert.equal(t.rows[0].join("|"), rows[0].join("|"), "header row repeated in every part");
  }
  // continues_from / continues_to are wired (stitch does that; verify direct check works)
  const ids = tableChunks.flatMap((c) => c.elements.filter((e) => e.type === "table").map((e) => e.id));
  assert.equal(ids.length, tableChunks.length);
  assert.equal(stats.completeness.pass, true);
});

test("undersized sibling sections under the same parent are merged", () => {
  const elements = withIds([
    heading(1, "Part", 1),
    heading(1, "Tiny A", 2),
    para(1, "a"),
    heading(1, "Tiny B", 2),
    para(1, "b"),
  ]);
  const { chunks } = chunkDocument(elements, { maxTokens: 800, minTokens: 100 });
  const text = chunks.map((c) => c.text).join("\n");
  assert.ok(text.includes("Tiny A") && text.includes("Tiny B"));
  assert.ok(chunks.length <= 2, `expected merging, got ${chunks.length} chunks`);
});

test("toc chunk_ids reference real chunks", () => {
  const elements = withIds([
    heading(1, "Only", 1),
    para(1, "content"),
  ]);
  const { toc, chunks } = chunkDocument(elements, { maxTokens: 800, minTokens: 1 });
  const ids = new Set(chunks.map((c) => c.id));
  for (const entry of toc) {
    for (const id of entry.chunk_ids) assert.ok(ids.has(id), `toc references unknown chunk ${id}`);
  }
});

test("findMissingElementIds reports missing and duplicated ids", () => {
  const elements = withIds([para(1, "x"), para(1, "y")]);
  const chunkA = { id: "c001", elements: [elements[0]] };
  const chunkB = { id: "c002", elements: [elements[0], elements[1]] };
  const report = findMissingElementIds(elements, [chunkA, chunkB]);
  assert.equal(report.pass, false);
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.duplicated, [elements[0].id]);
});

test("lists and equations stay in the same chunk as their surroundings", () => {
  const elements = withIds([
    heading(1, "Sec", 1),
    para(1, "Before."),
    listElement({ page: 1, bbox, text: "• one\n• two", source: "script" }),
    para(1, "After."),
  ]);
  const { chunks } = chunkDocument(elements, { maxTokens: 800, minTokens: 1 });
  assert.equal(chunks.length, 1);
});
