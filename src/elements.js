// src/elements.js
// Element factory + deterministic id assignment + bbox normalization.

let globalCounter = 0;

/** Clamp a bbox into [0,1]^2 and guarantee ordering. */
export function clampBBox(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4 || bbox.some((v) => typeof v !== "number" || Number.isNaN(v))) {
    return null;
  }
  let [x0, y0, x1, y1] = bbox.map(Number);
  x0 = Math.min(Math.max(x0, 0), 1);
  y0 = Math.min(Math.max(y0, 0), 1);
  x1 = Math.min(Math.max(x1, 0), 1);
  y1 = Math.min(Math.max(y1, 0), 1);
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}

/**
 * Normalize a bbox expressed in PDF user-space points (bottom-left origin, as
 * produced by unpdf) into [0,1]^2 with a top-left origin.
 */
export function normalizeScriptBBox({ x, y, width, height }, pageWidthPt, pageHeightPt) {
  const x0 = x / pageWidthPt;
  const x1 = (x + (width || 0)) / pageWidthPt;
  const yTop = (pageHeightPt - (y + (height || 0))) / pageHeightPt;
  const yBottom = (pageHeightPt - y) / pageHeightPt;
  return clampBBox([x0, yTop, x1, Math.max(yTop, yBottom)]) ?? [0, 0, 1, 1];
}

/** Normalize an already-0..1 bbox (model output); returns null if invalid. */
export function normalizeUnitBBox(bbox) {
  return clampBBox(bbox);
}

function baseElement(partial) {
  return {
    id: null, // assigned deterministically after stitch/order
    type: partial.type,
    page: partial.page,
    bbox: partial.bbox,
    text: partial.text ?? "",
    source: partial.source,
    needs_review: Boolean(partial.needs_review),
    ...partial.extra,
  };
}

export function paragraphElement({ page, bbox, text, source, needs_review = false, extra }) {
  return baseElement({ type: "paragraph", page, bbox, text, source, needs_review, extra });
}

export function headingElement({ page, bbox, text, level, source, needs_review = false, extra }) {
  return baseElement({ type: "heading", page, bbox, text, source, needs_review, extra: { level, ...extra } });
}

export function listElement({ page, bbox, text, source, needs_review = false, extra }) {
  return baseElement({ type: "list", page, bbox, text, source, needs_review, extra });
}

export function codeElement({ page, bbox, text, source, needs_review = false, extra }) {
  return baseElement({ type: "code", page, bbox, text, source, needs_review, extra });
}

export function equationElement({ page, bbox, text, source, needs_review = false, extra }) {
  return baseElement({ type: "equation", page, bbox, text, source, needs_review, extra });
}

export function captionElement({ page, bbox, text, source, needs_review = false, extra }) {
  return baseElement({ type: "caption", page, bbox, text, source, needs_review, extra });
}

export function tableElement({ page, bbox, rows, header_rows, caption, source, needs_review = false, continues_from, continues_to, extra }) {
  return baseElement({
    type: "table", page, bbox, source, needs_review,
    extra: {
      rows,
      header_rows: Number.isInteger(header_rows) ? header_rows : (rows.length ? 1 : 0),
      caption: caption ?? null,
      continues_from: continues_from ?? null,
      continues_to: continues_to ?? null,
      text: tableToMarkdown(rows, header_rows),
      ...extra,
    },
  });
}

export function figureElement({ page, bbox, figure_type, description, caption, data, source, needs_review = false, extra }) {
  return baseElement({
    type: "figure", page, bbox, source, needs_review,
    extra: {
      figure_type: figure_type || "other",
      description: description || "",
      caption: caption ?? null,
      data: data ?? null,
      ...extra,
    },
  });
}

/**
 * Assign sequential, stable ids (e0001..eN) in the order given. Counter resets
 * are the caller's job: reruns over the same deterministic pipeline produce
 * the same ids.
 */
export function assignElementIds(elements, start = 0) {
  globalCounter = start;
  return elements.map((el) => {
    globalCounter += 1;
    return { ...el, id: `e${String(globalCounter).padStart(4, "0")}` };
  });
}

export function tableToMarkdown(rows, headerRows = 1) {
  if (!Array.isArray(rows) || rows.length === 0) return "";
  const escapeCell = (cell) => String(cell ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  const renderRow = (row) => `| ${row.map(escapeCell).join(" | ")} |`;
  const lines = [];
  rows.forEach((row, idx) => {
    lines.push(renderRow(row));
    if (idx === Math.max(0, headerRows - 1)) {
      lines.push(`| ${row.map(() => " --- ").join("|")} |`);
    }
  });
  return lines.join("\n");
}
