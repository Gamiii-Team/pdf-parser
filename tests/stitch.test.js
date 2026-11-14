// tests/stitch.test.js — table continuation across pages + caption pairing.
import { test } from "node:test";
import assert from "node:assert/strict";

import { stitchElements } from "../src/stitch.js";
import { tableElement, figureElement, captionElement, paragraphElement, headingElement } from "../src/elements.js";

const bbox1 = [0.1, 0.7, 0.9, 0.9];
const bbox2 = [0.1, 0.05, 0.9, 0.3];

test("a table continuing on the next page merges, repeating nothing and keeping the caption", () => {
  const elements = [
    tableElement({ page: 1, bbox: bbox1, rows: [["A", "B"], ["1", "2"]], header_rows: 1, caption: "Table 1: split", source: "script" }),
    tableElement({ page: 2, bbox: bbox2, rows: [["A", "B"], ["3", "4"]], header_rows: 1, caption: null, source: "script" }),
  ];
  const out = stitchElements(elements, { maxTokens: 800 });
  const tables = out.filter((e) => e.type === "table");
  assert.equal(tables.length, 1, "the two page tables merged into one");
  assert.deepEqual(tables[0].rows, [["A", "B"], ["1", "2"], ["3", "4"]]);
  assert.equal(tables[0].spans_pages.join(","), "1,2");
  assert.equal(tables[0].caption, "Table 1: split");
});

test("the continuation variant without header rows merges without dropping data", () => {
  const elements = [
    tableElement({ page: 1, bbox: bbox1, rows: [["A", "B"], ["1", "2"]], header_rows: 1, caption: null, source: "script" }),
    tableElement({ page: 2, bbox: bbox2, rows: [["3", "4"], ["5", "6"]], header_rows: 0, caption: null, source: "script" }),
  ];
  const out = stitchElements(elements, { maxTokens: 800 });
  assert.equal(out.filter((e) => e.type === "table").length, 1);
  assert.deepEqual(out[0].rows, [["A", "B"], ["1", "2"], ["3", "4"], ["5", "6"]]);
});

test("a caption below a figure is paired atomically with it", () => {
  const elements = [
    headingElement({ page: 1, bbox: [0.1, 0.05, 0.9, 0.1], text: "Sec", level: 1, source: "script" }),
    figureElement({ page: 1, bbox: [0.1, 0.2, 0.9, 0.5], figure_type: "pie_chart", description: "Pie", caption: null, source: "florence" }),
    captionElement({ page: 1, bbox: [0.1, 0.52, 0.9, 0.56], text: "Figure 1: Pie", source: "script" }),
  ];
  const out = stitchElements(elements, { maxTokens: 800 });
  const figure = out.find((e) => e.type === "figure");
  const caption = out.find((e) => e.type === "caption");
  assert.equal(figure.caption, "Figure 1: Pie");
  assert.equal(figure.atomic_group, caption.atomic_group);
});

test("element ids are assigned in reading order and deterministic", () => {
  const elements = [
    paragraphElement({ page: 1, bbox: [0.1, 0.5, 0.9, 0.6], text: "second", source: "script" }),
    paragraphElement({ page: 1, bbox: [0.1, 0.1, 0.9, 0.2], text: "first", source: "script" }),
  ];
  const out = stitchElements(elements, { maxTokens: 800 });
  assert.equal(out[0].id, "e0001");
  assert.equal(out[1].id, "e0002");
});

test("non-continuation lookalike tables are NOT merged", () => {
  const elements = [
    tableElement({ page: 1, bbox: bbox1, rows: [["A", "B"], ["1", "2"]], header_rows: 1, caption: null, source: "script" }),
    tableElement({ page: 2, bbox: bbox2, rows: [["X", "Y", "Z"], ["3", "4", "5"]], header_rows: 1, caption: null, source: "script" }),
  ];
  const out = stitchElements(elements, { maxTokens: 800 });
  assert.equal(out.filter((e) => e.type === "table").length, 2);
});
