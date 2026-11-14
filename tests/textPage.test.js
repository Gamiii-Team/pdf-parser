// tests/textPage.test.js — against the committed test.pdf fixture.
// Uses the real PyMuPDF worker (offline).

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { analyzePdf } from "../src/pymupdf/run.js";
import { extractTextPage } from "../src/extract/textPage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_PDF = path.resolve(__dirname, "..", "test.pdf");

const pages = await analyzePdf(TEST_PDF);
const { bodySize, blocks } = extractTextPage(pages.pages);

const find = (type, pred) => blocks.filter((b) => b.type === type && (!pred || pred(b)));

test("body font size detected as 11pt", () => {
  assert.equal(bodySize, 11);
});

test("document title is an h1 heading on page 1", () => {
  const title = find("heading", (b) => b.content === "Sample Report with Tables & Images")[0];
  assert.ok(title, "title heading not found");
  assert.equal(title.level, 1);
  assert.equal(title.page, 1);
});

test("numbered headings are h2", () => {
  const h2s = find("heading", (b) => b.level === 2).map((b) => b.content);
  assert.ok(h2s.includes("1. Overview"));
  assert.ok(h2s.includes("2. Monthly Figures"));
  assert.ok(h2s.includes("3. Charts"));
  assert.ok(h2s.includes("4. Product Comparison"));
});

test("all three bullets appear in one list block", () => {
  const lists = find("list");
  assert.ok(lists.length >= 1);
  const bullets = lists.flatMap((l) => l.items ?? []);
  assert.ok(bullets.some((i) => i.includes("Revenue grew steadily")));
  assert.ok(bullets.some((i) => i.includes("Product A remains")));
  assert.ok(bullets.some((i) => i.includes("Costs stayed within budget")));
});

test("page 1 table extracted with proper columns and rows", () => {
  const tbl = find("table").find((b) => b.page === 1);
  assert.ok(tbl, "page-1 table not found");
  assert.deepEqual(tbl.content.columns, ["Month", "Revenue ($K)", "Costs ($K)", "Profit ($K)"]);
  assert.equal(tbl.content.rows.length, 6);
  assert.equal(tbl.content.rows[0][0], "January");
  assert.equal(tbl.content.rows[5][0], "June");
  assert.equal(tbl.caption, "Table 1: Monthly financial summary");
});

test("page 2 table extracted", () => {
  const tbl = find("table").find((b) => b.page === 2);
  assert.ok(tbl, "page-2 table not found");
  assert.deepEqual(tbl.content.columns, ["Product", "Units Sold", "Avg. Price", "Rating"]);
  assert.equal(tbl.content.rows.length, 4);
  assert.equal(tbl.caption, "Table 2: Product comparison");
});

test("both figures are detected on page 2 with captions", () => {
  const figs = find("figure-image", (b) => b.page === 2);
  assert.equal(figs.length, 2);
  const caps = figs.map((f) => f.caption).sort();
  assert.deepEqual(caps, ["Figure 1: Monthly revenue", "Figure 2: Share of sales by product"]);
});

test("figure-image captions are consumed (not duplicated as stray caption blocks)", () => {
  const strays = find("caption");
  for (const s of strays) {
    assert.notEqual(s.content, "Figure 1: Monthly revenue");
    assert.notEqual(s.content, "Table 1: Monthly financial summary");
  }
});
