// src/crop.js — high-res clip render of a figure region from the job's source.pdf.
// Used by the re-run crop path and the crop-preview endpoint on the review screen.
// Crops are never written outside the job folder (deleted with the 24h sweep or DELETE).

import fs from "node:fs";
import path from "node:path";
import { cropRegion, analyzePdf } from "./pymupdf/run.js";

/**
 * Render a normalized box (0-1) of one page to a PNG, padded by `pad` (default 3%),
 * clamped to the page. The DPI is capped so the longest side stays <= maxDim (default 2048).
 * @returns {Promise<{ out: string, dpi: number, width_px: number, height_px: number }>}
 */
export async function renderFigureCrop(sourcePdf, page, box, outPng, { pad = 0.03, dpi = 300, maxDim = 2048 } = {}) {
  if (!fs.existsSync(sourcePdf)) throw new Error("source.pdf missing for this job — crop unavailable");
  const analysis = await analyzePdf(sourcePdf);
  const info = (analysis.pages ?? []).find((p) => p.page === page);
  if (!info) throw new Error(`page ${page} not found in converted pdf`);
  const W = info.width ?? 612, H = info.height ?? 792;

  const box_x0 = box[0], box_y0 = box[1], box_x1 = box[2], box_y1 = box[3];
  if (!(box_x1 > box_x0) || !(box_y1 > box_y0)) {
    throw new Error("crop box is empty after padding/clamping");
  }
  const x0 = Math.max(0, box_x0 - pad), y0 = Math.max(0, box_y0 - pad);
  const x1 = Math.min(1, box_x1 + pad), y1 = Math.min(1, box_y1 + pad);
  if (!(x1 > x0) || !(y1 > y0)) {
    throw new Error("crop box is empty after padding/clamping");
  }

  const spanPt = Math.max((x1 - x0) * W, (y1 - y0) * H);
  const capped = Math.floor((maxDim * 72) / spanPt);
  const finalDpi = Math.max(72, Math.min(dpi, capped));

  fs.mkdirSync(path.dirname(outPng), { recursive: true });
  await cropRegion(sourcePdf, page, x0 * W, y0 * H, x1 * W, y1 * H, finalDpi, outPng);
  return {
    out: outPng,
    dpi: finalDpi,
    width_px: Math.round((x1 - x0) * W * (finalDpi / 72)),
    height_px: Math.round((y1 - y0) * H * (finalDpi / 72)),
  };
}
