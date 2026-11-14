// src/stitch.js
// Stitch step: merge cross-page tables, split oversized tables, pair captions
// with their figure/table (atomic groups), normalize heading levels, assign
// deterministic element ids, and wire table-split links.

import { elementTokenEstimate, estimateTokens } from "./util/token.js";
import { assignElementIds, tableToMarkdown } from "./elements.js";

function normalizeText(s) {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function tableColCount(table) {
  const widths = (table.rows ?? []).map((r) => r.length);
  return widths.length ? Math.max(...widths) : 0;
}

function sameColumnCount(a, b) {
  return tableColCount(a) > 0 && tableColCount(a) === tableColCount(b);
}

function firstRowEquals(a, b) {
  const ra = (a.rows?.[0] ?? []).map(normalizeText);
  const rb = (b.rows?.[0] ?? []).map(normalizeText);
  return ra.length === rb.length && ra.every((v, i) => v === rb[i]);
}

/** Merge tables that continue across a page boundary. */
function mergeCrossPageTables(elements) {
  const out = [];
  for (const el of elements) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.type === "table" &&
      el.type === "table" &&
      el.page === prev.page + 1 &&
      sameColumnCount(prev, el) &&
      (firstRowEquals(prev, el) || (el.header_rows ?? 0) === 0)
    ) {
      let rows = el.rows ?? [];
      if (firstRowEquals(prev, el)) rows = rows.slice(1); // drop duplicated header
      if (rows.length === 0) continue; // nothing new to merge
      const mergedRows = [...(prev.rows ?? []), ...rows];
      out[out.length - 1] = {
        ...prev,
        rows: mergedRows,
        text: tableToMarkdown(mergedRows, prev.header_rows ?? 1),
        page: prev.page,
        spans_pages: [prev.page, el.page],
        bbox: prev.bbox,
        continues_to: el.continues_to ?? null,
      };
      continue;
    }
    out.push(el);
  }
  return out;
}

/**
 * Split a table whose rendered size exceeds maxTokens into parts that each fit.
 * Header rows are repeated in every part; the caption stays on the first part.
 */
function splitOversizedTables(elements, maxTokens) {
  const out = [];
  for (const el of elements) {
    if (el.type !== "table" || elementTokenEstimate(el) <= maxTokens) {
      out.push(el);
      continue;
    }
    const headerRows = el.header_rows ?? 1;
    const header = (el.rows ?? []).slice(0, headerRows);
    const body = (el.rows ?? []).slice(headerRows);
    const avgRowChars = Math.max(
      20,
      Math.ceil((body.reduce((s, r) => s + r.join(" | ").length, 0) || 40) / Math.max(1, body.length)),
    );
    // Budget rows so that header + rows * avgRowChars <= maxTokens*4 chars.
    const budgetChars = maxTokens * 4 - header.reduce((s, r) => s + r.join(" | ").length + 4, 0);
    const rowsPerPart = Math.max(1, Math.floor(budgetChars / (avgRowChars + 4)));

    const parts = [];
    for (let i = 0; i < body.length; i += rowsPerPart) {
      parts.push(body.slice(i, i + rowsPerPart));
    }
    const splitGroup = `split-${parts.length}-${el.page}`;
    parts.forEach((slice, index) => {
      const rows = [...header, ...slice];
      out.push({
        ...el,
        rows,
        header_rows: headerRows,
        text: tableToMarkdown(rows, headerRows),
        caption: index === 0 ? el.caption ?? null : null,
        split_group: splitGroup,
        split_index: index,
        split_total: parts.length,
        atomic_group: index === 0 ? el.atomic_group ?? undefined : undefined,
      });
    });
  }
  return out;
}

function wireTableSplitLinks(elements) {
  const groups = new Map();
  for (const el of elements) {
    if (!el.split_group) continue;
    if (!groups.has(el.split_group)) groups.set(el.split_group, []);
    groups.get(el.split_group).push(el);
  }
  for (const parts of groups.values()) {
    parts.sort((a, b) => a.split_index - b.split_index);
    for (let i = 0; i < parts.length; i++) {
      parts[i].continues_from = i > 0 ? parts[i - 1].id : null;
      parts[i].continues_to = i < parts.length - 1 ? parts[i + 1].id : null;
    }
  }
}

/** Pair each caption with the nearest table/figure on the same page (atomic). */
function pairCaptions(elements) {
  let counter = 0;
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (el.type !== "caption" || el.atomic_group) continue;
    let best = null;
    let bestDist = Infinity;
    for (let j = Math.max(0, i - 3); j <= Math.min(elements.length - 1, i + 3); j++) {
      const other = elements[j];
      if (other === el) continue;
      if (other.type !== "table" && other.type !== "figure") continue;
      if (other.page !== el.page) continue;
      const dist = Math.abs(j - i);
      if (dist < bestDist) { best = other; bestDist = dist; }
    }
    if (best) {
      counter += 1;
      const group = `ag-${counter}`;
      el.atomic_group = group;
      best.atomic_group = group;
      if (best.caption == null) best.caption = el.text;
    }
  }
  return elements;
}

/** Collapse heading levels that jump upward (e.g. h4 directly under h1) to +1. */
function normalizeHeadingLevels(elements) {
  let lastLevel = 0;
  for (const el of elements) {
    if (el.type !== "heading") continue;
    const raw = Math.max(1, Math.min(el.level ?? 1, 6));
    el.level = lastLevel === 0 ? raw : Math.min(raw, lastLevel + 1);
    lastLevel = el.level;
  }
  return elements;
}

/**
 * @param {Array<object>} elements ordered by page + reading order, no ids yet
 * @param {{ maxTokens?: number }} opts
 */
export function stitchElements(elements, opts = {}) {
  const maxTokens = opts.maxTokens ?? 800;
  let out = elements.filter(Boolean);
  out = normalizeHeadingLevels(out);
  out = pairCaptions(out);
  out = mergeCrossPageTables(out);
  out = splitOversizedTables(out, maxTokens);
  out = assignElementIds(out);
  wireTableSplitLinks(out);
  return out;
}
