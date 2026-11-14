// src/pdfModel.js
// Build elements from a born-digital PDF's text layer (unpdf).
// Extends the existing text-extraction stack (src/extractor.js stays as the
// demo/CLI it was; this module is the structured counterpart).
//
// Heuristics (tuned on the repo's test.pdf; flagged when unsure):
//   fontSize >= 20            -> heading level 1
//   14 <= fontSize < 20       -> heading level 2
//   12.5 <= fontSize < 14     -> heading level 3
//   caption regex match       -> caption element
//   line of only bullet glyph -> merges into the following line as a list item
//   runs of >= 2 multi-column, consistent x-grid, fontSize <= 11.5 -> table
//   anything else             -> paragraph (consecutive lines merged)

import fs from "node:fs";
import { extractTextItems } from "unpdf";

import { getPdfInfo } from "./render.js";
import {
  paragraphElement, headingElement, listElement, tableElement, captionElement,
  normalizeScriptBBox,
} from "./elements.js";

const CAPTION_RE = /^(table|figure|fig\.?|chart|graph|exhibit)\s*[0-9]/i;
const BULLET_ONLY_RE = /^[•◦\-\*·]\s*$/;
const BULLET_PREFIX_RE = /^[•◦\-\*·]\s*/;
const Y_TOLERANCE_PT = 4;
const MAX_TABLE_FONT = 11.5;
const MIN_TABLE_LINES = 2;
const CELL_GAP_PT = 11; // horizontal gap that separates table columns (dense tables have ~12pt inter-column gaps)
const MIN_COL_COUNT = 2;

function groupItemsIntoLines(items) {
  const clean = items.filter((it) => it && typeof it.str === "string" && it.str.trim().length > 0);
  // unpdf y is bottom-up: higher y == higher on the page.
  const sorted = [...clean].sort((a, b) => (b.y - a.y) || (a.x - b.x));
  const lines = [];
  let current = null;
  for (const item of sorted) {
    if (!current || Math.abs(current.y - item.y) > Y_TOLERANCE_PT) {
      if (current) lines.push(finishLine(current));
      current = { y: item.y, items: [item] };
    } else {
      current.items.push(item);
    }
  }
  if (current) lines.push(finishLine(current));
  return lines;
}

function finishLine(line) {
  const items = [...line.items].sort((a, b) => a.x - b.x);
  const text = items.map((i) => i.str.trim()).filter(Boolean).join(" ").replace(/\s{2,}/g, " ").trim();
  const x0 = Math.min(...items.map((i) => i.x));
  const y0 = Math.min(...items.map((i) => i.y));
  const x1 = Math.max(...items.map((i) => i.x + (i.width || 0)));
  const y1 = Math.max(...items.map((i) => i.y + (i.height || 0)));
  const fontSize = Math.max(...items.map((i) => i.fontSize || 0));
  return { text, items, x0, y0, x1, y1, fontSize };
}

function normBBox(line, info) {
  return normalizeScriptBBox(
    { x: line.x0, y: line.y0, width: line.x1 - line.x0, height: Math.max(1, line.y1 - line.y0) },
    info.widthPt,
    info.heightPt,
  );
}

function mergeBulletOnlyLines(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (BULLET_ONLY_RE.test(line.text) && i + 1 < lines.length) {
      const next = lines[i + 1];
      out.push({
        ...next,
        text: `• ${next.text}`,
        x0: Math.min(line.x0, next.x0),
        fontSize: next.fontSize,
        bulletMerged: true,
      });
      i += 1; // consume the following line
      continue;
    }
    out.push(line);
  }
  return out;
}

/** Split a line's items into cells by horizontal gaps (the column signal). */
function cellsForLineGapSplit(line) {
  const items = line.items.filter((it) => it.str.trim()).sort((a, b) => a.x - b.x);
  if (items.length === 0) return [];
  const cells = [[items[0]]];
  for (let i = 1; i < items.length; i += 1) {
    const prev = items[i - 1];
    const curr = items[i];
    const gap = curr.x - (prev.x + (prev.width || 0));
    if (gap > CELL_GAP_PT) cells.push([curr]);
    else cells[cells.length - 1].push(curr);
  }
  return cells.map((cellItems) => cellItems.map((it) => it.str.trim()).filter(Boolean).join(" ").trim());
}

function findTableRuns(lines) {
  const runs = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Gap-split each line into cells; a "table line" has >= 2 cells.
    const isTableLine = (l) =>
      l.fontSize <= MAX_TABLE_FONT &&
      !CAPTION_RE.test(l.text) &&
      !BULLET_PREFIX_RE.test(l.text) &&
      cellsForLineGapSplit(l).length >= MIN_COL_COUNT;

    if (!isTableLine(line)) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < lines.length && isTableLine(lines[j])) j += 1;
    const run = lines.slice(i, j);
    if (run.length >= MIN_TABLE_LINES) {
      const counts = run.map((l) => cellsForLineGapSplit(l).length);
      const freq = new Map();
      for (const c of counts) freq.set(c, (freq.get(c) ?? 0) + 1);
      const [dominant, dominantCount] = [...freq.entries()].sort((a, b) => b[1] - a[1])[0];
      // All lines must agree on the column count, or the dominant count must
      // cover >= 70% of lines (ragged tables are kept but flagged).
      if (dominant >= MIN_COL_COUNT && dominantCount / run.length >= 0.7) {
        runs.push({ start: i, end: j, colCount: dominant, ragged: dominantCount !== run.length });
        i = j;
        continue;
      }
    }
    i += 1;
  }
  return runs;
}

function bboxUnion(elements) {
  const [a, b, c, d] = [
    Math.min(...elements.map((e) => e.bbox[0])),
    Math.min(...elements.map((e) => e.bbox[1])),
    Math.max(...elements.map((e) => e.bbox[2])),
    Math.max(...elements.map((e) => e.bbox[3])),
  ];
  return [a, b, c, d];
}

/**
 * Build elements from one page's positioned text items (unpdf shape OR a
 * synthetic shape that the Florence OCR path produces).
 *
 * @param {Array<object>} items  text items with { str, x, y, width, height, fontSize }
 * @param {number} page 1-based page number
 * @param {{widthPt:number, heightPt:number}} info  PDF page size in points
 * @param {string} [source] element source tag ("script" | "florence")
 * @returns {Array<object>} elements (no ids — assigned later in stitch)
 */
export function extractElementsFromItems(items, page, info, logger, source = "script") {
  const rawLines = groupItemsIntoLines(items ?? []);
    const lines = mergeBulletOnlyLines(rawLines);
    const tableRuns = findTableRuns(lines);
    const tableLineIdx = new Set();
    for (const run of tableRuns) {
      for (let k = run.start; k < run.end; k += 1) tableLineIdx.add(k);
    }

    const out = [];
    let paragraphBuffer = [];

    const flushParagraph = () => {
      if (paragraphBuffer.length === 0) return;
      const text = paragraphBuffer.map((l) => l.text).join(" ").replace(/\s{2,}/g, " ").trim();
      out.push(paragraphElement({
        page,
        bbox: bboxUnion(paragraphBuffer),
        text,
        source,
        needs_review: false,
      }));
      paragraphBuffer = [];
    };

    let i = 0;
    while (i < lines.length) {
      // Table run starting at i?
      const run = tableRuns.find((r) => r.start === i);
      if (run) {
        flushParagraph();
        const runLines = lines.slice(run.start, run.end);
        const rawRows = runLines.map((line) => cellsForLineGapSplit(line).map((c) => c.trim()));
        // Pad ragged rows to the dominant column count so the table is rectangular.
        const rows = rawRows.map((r) => {
          if (r.length >= run.colCount) return r;
          return [...r, ...Array.from({ length: run.colCount - r.length }, () => "")];
        });
        const tableEls = runLines.map((line) => ({ bbox: normBBox(line, info) }));
        out.push(tableElement({
          page,
          bbox: bboxUnion(tableEls),
          rows,
          header_rows: 1,
          caption: null,
          source,
          needs_review: run.ragged,
          extra: run.ragged ? { notes: "ragged_table_grid" } : undefined,
        }));
        i = run.end;
        continue;
      }

      const line = lines[i];
      const bbox = normBBox(line, info);

      if (CAPTION_RE.test(line.text)) {
        flushParagraph();
        out.push(captionElement({ page, bbox, text: line.text, source, needs_review: false }));
        i += 1;
        continue;
      }

      const level = line.fontSize >= 20 ? 1 : line.fontSize >= 14 ? 2 : line.fontSize >= 12.5 ? 3 : 0;
      if (level > 0) {
        flushParagraph();
        out.push(headingElement({ page, bbox, text: line.text, level, source, needs_review: false }));
        i += 1;
        continue;
      }

      if (BULLET_PREFIX_RE.test(line.text)) {
        flushParagraph();
        out.push(listElement({ page, bbox, text: line.text, source, needs_review: false }));
        i += 1;
        continue;
      }

      if (tableLineIdx.has(i)) { i += 1; continue; } // consumed by its run above

      // Paragraph: split on vertical gap / font change
      const prev = paragraphBuffer[paragraphBuffer.length - 1];
      const verticalGap = prev ? (prev.y0 - line.y1) : 0;
      const fontChanged = prev ? prev.fontSize !== line.fontSize : false;
      if (prev && (verticalGap > 8 || fontChanged)) flushParagraph();
      paragraphBuffer.push({ ...line, bbox });
      i += 1;
    }
    flushParagraph();
    return out;
}

/**
 * @returns {Promise<Array<object>>} elements WITHOUT ids (ids assigned in stitch)
 */
export async function buildScriptElements(pdfPath, { logger } = {}) {
  const info = getPdfInfo(pdfPath);
  const bytes = new Uint8Array(fs.readFileSync(pdfPath));
  const { items } = await extractTextItems(bytes);

  const elements = [];
  for (let pageIndex = 0; pageIndex < items.length; pageIndex += 1) {
    const pageElements = extractElementsFromItems(items[pageIndex] ?? [], pageIndex + 1, info, logger, "script");
    elements.push(...pageElements);
  }
  logger?.debug?.(`script elements: ${elements.length}`);
  return elements;
}
