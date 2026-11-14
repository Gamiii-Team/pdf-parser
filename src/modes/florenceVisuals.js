// src/modes/florenceVisuals.js
// Shared helpers for mapping Florence-2's figure detections to our figure
// elements. Used by hybrid-florence (script text + Florence figures) and
// full-florence (Florence text + Florence figures).

import { clampBBox, figureElement } from "../elements.js";

export const LABEL_TO_TYPE = {
  "pie chart": "pie_chart",
  "bar chart": "bar_chart",
  "line chart": "line_chart",
  "scatter plot": "scatter",
  "flowchart": "flowchart",
  "graph": "line_chart",
};

export function iou(a, b) {
  const ix0 = Math.max(a[0], b[0]), iy0 = Math.max(a[1], b[1]);
  const ix1 = Math.min(a[2], b[2]), iy1 = Math.min(a[3], b[3]);
  const iw = Math.max(0, ix1 - ix0), ih = Math.max(0, iy1 - iy0);
  const inter = iw * ih;
  const areaA = (a[2] - a[0]) * (a[3] - a[1]);
  const areaB = (b[2] - b[0]) * (b[3] - b[1]);
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}

/** Fraction of `inner` covered by `outer`. */
export function containment(inner, outer) {
  const ix0 = Math.max(inner[0], outer[0]), iy0 = Math.max(inner[1], outer[1]);
  const ix1 = Math.min(inner[2], outer[2]), iy1 = Math.min(inner[3], outer[3]);
  const iw = Math.max(0, ix1 - ix0), ih = Math.max(0, iy1 - iy0);
  const innerArea = (inner[2] - inner[0]) * (inner[3] - inner[1]);
  return innerArea > 0 ? (iw * ih) / innerArea : 0;
}

function horizOverlap(a, b) {
  return Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
}

/** Find the printed caption nearest to a figure on the same page. */
export function nearestCaption(figureEl, scriptElements) {
  let best = null;
  let bestDist = Infinity;
  for (const el of scriptElements) {
    if (el.type !== "caption" || el.page !== figureEl.page) continue;
    if (horizOverlap(figureEl.bbox, el.bbox) < -0.05) continue;
    const [fy0, fy1] = [figureEl.bbox[1], figureEl.bbox[3]];
    const [cy0, cy1] = [el.bbox[1], el.bbox[3]];
    let dist;
    if (cy1 <= fy0) dist = fy0 - cy1;
    else if (cy0 >= fy1) dist = cy0 - fy1;
    else dist = 0;
    if (dist > 0.09) continue;
    if (dist < bestDist) { best = el; bestDist = dist; }
  }
  return best;
}

/**
 * Map raw per-page Florence detections → normalized, de-duplicated figure elements.
 *
 * - Converts pixel bboxes to normalized 0-1
 * - Drops whole-page boxes (oversized) and near-identical boxes on same page
 * - Order: top to bottom
 */
export function mapDetections(pagesDetections, { pxWidth, pxHeight, logger }) {
  let figureElements = [];
  const warnings = [];
  for (const { page, detections, page_error: pageError } of pagesDetections) {
    if (pageError) {
      warnings.push(`figure detection page ${page} failed: ${pageError}`);
      continue;
    }
    for (const det of detections ?? []) {
      const [x1, y1, x2, y2] = (det.bbox ?? [0, 0, 0, 0]).map(Number);
      const bbox = clampBBox([x1 / pxWidth, y1 / pxHeight, x2 / pxWidth, y2 / pxHeight]);
      if (!bbox) continue;
      const label = String(det.label ?? "").trim().toLowerCase();
      const figureType = LABEL_TO_TYPE[label] ?? (label === "table" ? "table_image" : "other");
      figureElements.push({
        rawLabel: label,
        captionText: String(det.caption ?? "").trim(),
        el: figureElement({
          page,
          bbox,
          figure_type: figureType,
          description: String(det.caption ?? "").trim(),
          caption: null,
          data: null,
          source: "florence",
          needs_review: !String(det.caption ?? "").trim(),
        }),
      });
    }
  }

  // Drop oversized (whole-page boxes)
  const sized = figureElements.filter(({ el }) => {
    const area = (el.bbox[2] - el.bbox[0]) * (el.bbox[3] - el.bbox[1]);
    const drop = area > 0.8;
    if (drop) logger?.debug?.(`dropping oversized detection on page ${el.page} (${area.toFixed(2)} of page)`);
    return !drop;
  });

  // Dedup near-identical boxes (IoU > 0.6 or containment > 0.8 on the same page)
  const byPriority = [...sized].sort((a, b) => {
    const captionLen = (b.el.caption?.length ?? 0) - (a.el.caption?.length ?? 0);
    if (captionLen !== 0) return captionLen;
    const areaA = (a.el.bbox[2] - a.el.bbox[0]) * (a.el.bbox[3] - a.el.bbox[1]);
    const areaB = (b.el.bbox[2] - b.el.bbox[0]) * (b.el.bbox[3] - b.el.bbox[1]);
    return areaB - areaA;
  });
  const deduped = [];
  for (const cand of byPriority) {
    const dup = deduped.find((k) => k.el.page === cand.el.page &&
      (iou(k.el.bbox, cand.el.bbox) > 0.6 ||
       containment(cand.el.bbox, k.el.bbox) > 0.8 ||
       containment(k.el.bbox, cand.el.bbox) > 0.8));
    if (!dup) deduped.push(cand);
  }
  figureElements = deduped.sort((a, b) => (a.el.bbox[1] - b.el.bbox[1]));

  return { figureElements, warnings };
}

/**
 * Drop Florence "table_image" detections that overlap a trusted script table
 * (script wins), anchor figures to printed captions (best effort), return the
 * list of figure elements to merge in.
 */
export function anchorFigures(figureElements, scriptElements, { dropTableImagesOverlappingScript = true } = {}) {
  const scriptTables = (scriptElements ?? []).filter((el) => el.type === "table");
  const figures = [];
  for (const { el } of figureElements) {
    if (dropTableImagesOverlappingScript && el.figure_type === "table_image") {
      const overlap = scriptTables.some((t) => t.page === el.page && iou(t.bbox, el.bbox) > 0.3);
      if (overlap) continue;
      el.needs_review = true;
    }
    const captionEl = nearestCaption(el, scriptElements);
    if (captionEl) {
      el.caption = captionEl.text;
      el.bbox = [
        Math.min(el.bbox[0], captionEl.bbox[0]),
        Math.min(el.bbox[1], captionEl.bbox[1]),
        Math.max(el.bbox[2], captionEl.bbox[2]),
        Math.max(el.bbox[3], captionEl.bbox[3]),
      ];
    } else {
      el.caption = null;
    }
    figures.push(el);
  }
  return figures;
}
