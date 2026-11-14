// src/modes/fullFlorence.js
// Mode B (full-florence): every element in the manifest comes from the
// deployed Florence-2 Modal app — text via <OCR>, figure boxes via
// <CAPTION_TO_PHRASE_GROUNDING>. NO unpdf / text-layer help.

import fs from "node:fs";

import { extractElementsFromItems } from "../pdfModel.js";
import { detectInPdf } from "../florenceClient.js";
import { getFigureAnalyzer } from "../figureAnalyzer/index.js";
import { getPdfInfo } from "../render.js";
import { config } from "../config.js";
import { mapDetections, anchorFigures } from "./florenceVisuals.js";

const MAX_TOKEN_HEIGHT_PT = 120; // sanity cap on OCR boxes for pathological occlusion results

function cleanTokenText(text) {
  if (!text) return "";
  // Florence sometimes prepends a literal "</s>" on the first token.
  return String(text).replace(/^<\/s>/, "").trim();
}

/** Convert Florence OCR tokens (top-origin, pixel coords) -> unpdf items (bottom-origin, pt). */
function ocrTokenToItems(tokens, info, dpi) {
  const pxToPt = 72 / dpi;
  const items = [];
  for (const tok of tokens ?? []) {
    const text = cleanTokenText(tok.text);
    if (!text) continue;
    const b = tok.bbox ?? [];
    if (!Array.isArray(b) || b.length < 4) continue;
    const x0 = Math.max(0, Number(b[0]) * pxToPt);
    const y0 = Math.max(0, Number(b[1]) * pxToPt);
    const x1 = Math.min(info.widthPt, Number(b[2]) * pxToPt);
    const y1 = Math.min(info.heightPt, Number(b[3]) * pxToPt);
    if (x1 - x0 < 2 || y1 - y0 < 2) continue;
    const w = x1 - x0;
    const h = Math.min(MAX_TOKEN_HEIGHT_PT, y1 - y0);
    if (h <= 0) continue;
    const itemY = info.heightPt - y1;
    items.push({
      str: text,
      x: x0,
      y: itemY,
      width: w,
      height: h,
      fontSize: Math.max(6, h),
    });
  }
  // Florence often emits duplicate tokens for the same glyph run with a
  // sub-pixel-y offset. Drop lines that overlap spatially and share text.
  const seen = [];
  for (const item of items) {
    const dup = seen.find((o) => {
      if (o.str !== item.str) return false;
      if (Math.abs(o.y - item.y) > 10) return false;  // unpdf y (distance from bottom)
      const ix0 = Math.max(o.x, item.x), ix1 = Math.min(o.x + o.width, item.x + item.width);
      if (ix1 <= ix0) return false;
      return true;
    });
    if (dup) continue;
    seen.push(item);
  }
  // Stable reading order: top (from the page top) -> bottom
  return seen.slice().sort((a, b) => b.y - a.y || a.x - b.x);
}

/**
 * @param {{ inputPath: string, dpi?: number, figureAnalyzer?: string, figurePass?: boolean, logger, cache }} args
 */
export async function extractFullFlorence({ inputPath, dpi, figureAnalyzer = "florence", figurePass = false, logger, cache }) {
  if (!/\.pdf$/i.test(inputPath)) {
    throw new Error("full-florence only supports PDFs (the figure pass is PDF-only). Use --mode full-groq or full-modal for images.");
  }
  const info = getPdfInfo(inputPath);
  const currentDpi = dpi ?? config.dpi;
  const pxWidth = (info.widthPt * currentDpi) / 72;
  const pxHeight = (info.heightPt * currentDpi) / 72;

  // 1) Florence call (single round-trip: detections + OCR tokens)
  const pdfBytes = fs.readFileSync(inputPath);
  const warnings = [];
  let scriptElements = [];
  let figureElements = [];
  try {
    const { pages, source } = await detectInPdf({ pdfPath: inputPath, pdfBytes, dpi: currentDpi, config, logger });
    logger?.info?.(`florence extraction via ${source}`);
    const mapped = mapDetections(pages, { pxWidth, pxHeight, logger });
    figureElements = mapped.figureElements;
    if (mapped.warnings.length) warnings.push(...mapped.warnings);

    // 2) Convert Florence OCR tokens to unpdf-shape items per page
    for (const { page, ocr, page_error: pageError } of pages) {
      if (pageError) {
        warnings.push(`OCR page ${page} failed: ${pageError}`);
        continue;
      }
      if (!ocr || !Array.isArray(ocr.ocr_with_region)) {
        warnings.push(`OCR page ${page}: no OCR tokens returned`);
        continue;
      }
      const items = ocrTokenToItems(ocr.ocr_with_region, info, currentDpi);
      const pageElements = extractElementsFromItems(items, page, info, logger, "florence");
      scriptElements.push(...pageElements);
    }
  } catch (err) {
    logger?.error?.(`florence extraction failed: ${err.message}`);
    warnings.push(`florence extraction failed: ${err.message}`);
  }

  // 3) Anchor Florence figures to captions (works against whatever caption text was found)
  const figures = anchorFigures(figureElements, scriptElements, { dropTableImagesOverlappingScript: false });

  // 4) Optional figure pass
  if (figurePass && figures.length > 0) {
    const analyzer = getFigureAnalyzer(figureAnalyzer);
    logger?.info?.(`figure pass via ${figureAnalyzer}: ${figures.length} figure(s)`);
    for (const figure of figures) {
      try {
        const [x0, y0, x1, y1] = figure.bbox;
        const result = await analyzer.analyze({
          label: undefined,
          caption: figure.caption,
          bbox: [x0, y0, x1, y1],
          page: figure.page,
          figure_type: figure.figure_type,
          pdfPath: inputPath,
          dpi: currentDpi,
          pageWidthPx: pxWidth,
          pageHeightPx: pxHeight,
        });
        if (result.description) figure.description = result.description;
        if (result.figure_type && result.figure_type !== figure.figure_type) figure.figure_type = result.figure_type;
        figure.data = result.data ?? null;
        if (result.needs_review) figure.needs_review = true;
      } catch (err) {
        logger?.warn?.(`figure pass failed on page ${figure.page}: ${err.message}`);
        figure.needs_review = true;
        figure.notes = `figure_pass_failed: ${err.message}`;
      }
    }
  }

  // 5) Merge in reading order
  const merged = [...scriptElements, ...figures];
  merged.sort((a, b) => (a.page - b.page) || (a.bbox[1] - b.bbox[1]) || (a.bbox[0] - b.bbox[0]));
  return { elements: merged, warnings, pageCount: info.pages };
}
