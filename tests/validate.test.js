// tests/validate.test.js

import { test } from "node:test";
import assert from "node:assert/strict";

import { validateCharts, validateTables, validateTextCoverage } from "../src/validate/index.js";

test("chart validator flags series/x length mismatch", () => {
  const tree = [{ content: [{ type: "chart", id: "b1", chart_type: "bar", content: { x: ["a", "b"], series: [{ name: "s", values: [1, 2, 3] }] } }], subsections: [] }];
  const issues = validateCharts(tree);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, "chart_length_mismatch");
});

test("chart validator flags pie total not equal to 100", () => {
  const tree = [{ content: [{ type: "chart", id: "b2", chart_type: "pie", content: { slices: [{ percent: 10 }, { percent: 20 }] } }], subsections: [] }];
  const issues = validateCharts(tree);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, "pie_total_not_100");
});

test("table validator flags column/row width mismatch", () => {
  const tree = [{ content: [{ type: "table", id: "b3", content: { columns: ["a", "b"], rows: [["1"]] } }], subsections: [] }];
  const issues = validateTables(tree);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, "row_col_mismatch");
});

test("text coverage is computed per page", () => {
  const routed = [{ page: 1, route: "text-layer", text_chars: 10 }];
  const blocks = [{ page: 1, type: "text", content: "hello world!" }];
  const [r] = validateTextCoverage({ routedPages: routed, textBlocks: blocks });
  assert.ok(r.coverage >= 1);
  assert.equal(r.ok, true);
});
