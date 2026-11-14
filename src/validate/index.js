// src/validate/index.js
// §6 — Post-extraction validation. Runs WITHOUT any model calls.
// Returns a validation report; blocks that fail get needs_review: true attached by callers.

export const MIN_TEXT_COVERAGE = 0.75; // fraction of page text chars expected to appear in text blocks/tables

/** Text coverage per text-layer page: compares extracted chars vs worker-reported chars. */
export function validateTextCoverage({ routedPages, textBlocks }) {
  const results = [];
  for (const p of routedPages ?? []) {
    if (p.route !== "text-layer") continue;
    const pageTextChars = (p.text_chars ?? 0);
    if (pageTextChars <= 0) { results.push({ page: p.page, coverage: 1, ok: true }); continue; }
    const blocks = textBlocks.filter((b) => b.page === p.page);
    let covered = 0;
    for (const b of blocks) {
      if (typeof b.content === "string") covered += b.content.length;
      else if (Array.isArray(b.items)) covered += b.items.reduce((s, it) => s + String(it).length, 0);
      else if (b.type === "table" && b.content?.rows) {
        for (const row of b.content.rows) for (const cell of row) covered += String(cell ?? "").length;
        for (const col of b.content.columns ?? []) covered += String(col ?? "").length;
      }
    }
    const coverage = covered / pageTextChars; // may exceed 1 if bold-flags/2 earlier; fine
    results.push({ page: p.page, covered_chars: covered, page_text_chars: pageTextChars, coverage: Number(coverage.toFixed(3)), ok: coverage >= MIN_TEXT_COVERAGE });
  }
  return results;
}

/** Chart sanity: series values length matches x labels length (bar/line/scatter). */
export function validateCharts(blockTree) {
  const issues = [];
  const walk = (sections) => {
    for (const s of sections ?? []) {
      for (const c of s.content ?? []) {
        if (c.type === "chart") {
          const content = c.content;
          const ct = c.chart_type;
          if (ct === "bar" || ct === "line" || ct === "scatter") {
            const x = content?.x;
            const series = content?.series;
            if (Array.isArray(x) && Array.isArray(series)) {
              for (const sr of series) {
                if (Array.isArray(sr?.values) && sr.values.length !== x.length) {
                  issues.push({ block: c.id, kind: "chart_length_mismatch", message: `series "${sr?.name ?? "?"}" has ${sr.values.length} values, x has ${x.length}` });
                }
              }
            }
          }
          if (ct === "pie" && Array.isArray(content?.slices)) {
            const total = content.slices.reduce((s, x) => s + (Number(x.percent) || 0), 0);
            if (total > 0 && Math.abs(total - 100) > 1.5) {
              issues.push({ block: c.id, kind: "pie_total_not_100", message: `pie percent sums to ${total.toFixed(1)}` });
            }
          }
        }
      }
      walk(s.subsections ?? []);
    }
  };
  walk(blockTree);
  return issues;
}

/** Table sanity: nothing structurally broken (empty grid, fewer than 1 col). */
export function validateTables(blockTree) {
  const issues = [];
  const walk = (sections) => {
    for (const s of sections ?? []) {
      for (const c of s.content ?? []) {
        if (c.type === "table") {
          const cols = c.content?.columns ?? [];
          const rows = c.content?.rows ?? [];
          if (!cols.length && !rows.length) issues.push({ block: c.id, kind: "empty_table", message: "table has no columns or rows" });
          for (const row of rows) {
            if (Array.isArray(row) && cols.length && row.length !== cols.length) {
              issues.push({ block: c.id, kind: "row_col_mismatch", message: `row has ${row.length} cells, columns has ${cols.length}` });
            }
          }
        }
      }
      walk(s.subsections ?? []);
    }
  };
  walk(blockTree);
  return issues;
}
