// src/modes/hybridFlorence.js
// Mode A (hybrid-florence): script-based text/headings/tables (unpdf) for the
// text layer; figures + OCR tokens via the deployed Modal Florence-2 app.

import fs from "node:fs";

import { buildScriptElements } from "../pdfModel.js";
import { detectInPdf } from "../florenceClient.js";
import { getFigureAnalyzer } from "../figureAnalyzer/index.js";
import { getPdfInfo } from "../render.js";
import { config } from "../config.js";
import { mapDetections, anchorFigures } from "./florenceVisuals.js";

/**
 * @param {{ inputPath: string, dpi?: number, figureAnalyzer?: string, figurePass?: boolean, logger, cache }} args
 */
export async function extractHybridFlorence({ inputPath, dpi, figureAnalyzer = "florence", figurePass = false, logger, cache }) {
  if (!/\.pdf$/i.test(inputPath)) {
    throw new Error("hybrid-florence only supports PDFs (the figure pass is PDF-only). Use --mode full-groq or full-modal for images.");
  }
  const info = getPdfInfo(inputPath);
  const currentDpi = dpi ?? config.dpi;
  const pxWidth = (info.widthPt * currentDpi) / 72;
  const pxHeight = (info.heightPt * currentDpi) / 72;

  // 1) Script elements (text, headings, tables, lists, captions)
  const scriptElements = await buildScriptElements(inputPath, { logger });

  // 2) Figure detection via Modal (hard-fail the figure pass, not the document)
  const pdfBytes = fs.readFileSync(inputPath);
  const warnings = [];
  let figureElements = [];
  try {
    const { pages, source } = await detectInPdf({ pdfPath: inputPath, pdfBytes, dpi: currentDpi, config, logger });
    logger?.info?.(`florence figure detection via ${source}`);
    const mapped = mapDetections(pages, { pxWidth, pxHeight, logger });
    figureElements = mapped.figureElements;
    if (mapped.warnings.length) warnings.push(...mapped.warnings);
  } catch (err) {
    logger?.error?.(`florence figure detection failed: ${err.message}`);
    warnings.push(`figure detection failed: ${err.message}`);
  }

  // Drop Florence "table" detections that overlap a script table (script wins),
  // and anchor figures to printed captions.
  const figures = anchorFigures(figureElements, scriptElements);

  // 4) Optional figure pass: structured data via the configured analyzer
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

  // 5) Merge script + figure elements in reading order
  const merged = [...scriptElements, ...figures];
  merged.sort((a, b) => (a.page - b.page) || (a.bbox[1] - b.bbox[1]) || (a.bbox[0] - b.bbox[0]));
  return { elements: merged, warnings, pageCount: info.pages };
}
