// src/input/normalize.js
// §1 — Input normalization. Accepts PDF, PPTX or single-image. Single images are
// wrapped in a 1-page PDF via PyMuPDF; PPTX files are validated (see §2 in
// pptxValidate.js) and converted to PDF by LibreOffice inside a locked-down
// container (see pptxToPdf.js). Rejects > MAX_PAGES. Returns { pdfPath, analysis, cleanupPath }.

import path from "node:path";
import fs from "node:fs";
import os from "node:os";

import { analyzePdf, spawnWorker } from "../pymupdf/run.js";
import { config, MAX_PAGES } from "../config.js";
import { validatePptx } from "./pptxValidate.js";
import { convertPptxToPdf } from "./pptxToPdf.js";

export const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".tif", ".tiff", ".webp", ".bmp"]);

export async function normalizeInput(input, options = {}) {
  const resolved = path.resolve(input);
  if (!fs.existsSync(resolved)) throw new Error(`Input not found: ${resolved}`);
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || stat.size === 0) throw new Error(`Input is empty or not a file: ${resolved}`);
  const ext = path.extname(resolved).toLowerCase();
  options.onStage?.("converting");

  let pdfPath = resolved;
  let cleanupPath = null;
  let pptx = undefined; // set only for .pptx inputs: slide counts for reporting
  if (ext === ".pptx") {
    const validation = await validatePptx(resolved); // throws PptxValidationError with a specific, friendly message
    const converted = await convertPptxToPdf(resolved, { logger: options.logger, hideEmptySlides: (validation.empty ?? 0) > 0 });
    pdfPath = converted.pdfPath;
    cleanupPath = converted.pdfPath;
    pptx = {
      total: (validation.slides ?? 0) + (validation.hidden ?? 0) + (validation.empty ?? 0),
      visible: validation.slides ?? 0,
      hidden: validation.hidden ?? 0,
      empty: validation.empty ?? 0,
    };
  } else if (ext !== ".pdf") {
    if (!IMAGE_EXTS.has(ext)) throw new Error(`Unsupported input: ${ext}. Supported: .pdf, .pptx, .png, .jpg, .jpeg, .tif, .tiff, .webp, .bmp`);
    cleanupPath = path.join(os.tmpdir(), `docv2-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
    await spawnWorker(["image-to-pdf", resolved, cleanupPath]);
    pdfPath = cleanupPath;
  }

  const analysis = await analyzePdf(pdfPath);
  if (!analysis?.num_pages || analysis.num_pages < 1) throw new Error("Document has no pages.");
  if (analysis.num_pages > MAX_PAGES) throw new Error(`Document has ${analysis.num_pages} pages, exceeds the maximum of ${MAX_PAGES}. Split the document first.`);
  options.onStage?.("analyzing");

  return { pdfPath, cleanupPath, analysis, pptx };
}
