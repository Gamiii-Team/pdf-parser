// src/input/normalize.js
// §1 — Input normalization. Accepts PDF or single-image, wraps image in a
// 1-page PDF via PyMuPDF. Rejects > MAX_PAGES. Returns { pdfPath, analysis, cleanupPath }.

import path from "node:path";
import fs from "node:fs";
import os from "node:os";

import { analyzePdf, spawnWorker } from "../pymupdf/run.js";
import { config, MAX_PAGES } from "../config.js";

export const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".tif", ".tiff", ".webp", ".bmp"]);

export async function normalizeInput(input) {
  const resolved = path.resolve(input);
  if (!fs.existsSync(resolved)) throw new Error(`Input not found: ${resolved}`);
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || stat.size === 0) throw new Error(`Input is empty or not a file: ${resolved}`);
  const ext = path.extname(resolved).toLowerCase();

  let pdfPath = resolved;
  let cleanupPath = null;
  if (ext !== ".pdf") {
    if (!IMAGE_EXTS.has(ext)) throw new Error(`Unsupported input: ${ext}. Supported: .pdf, .png, .jpg, .jpeg, .tif, .tiff, .webp, .bmp`);
    cleanupPath = path.join(os.tmpdir(), `docv2-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
    await spawnWorker(["image-to-pdf", resolved, cleanupPath]);
    pdfPath = cleanupPath;
  }

  const analysis = await analyzePdf(pdfPath);
  if (!analysis?.num_pages || analysis.num_pages < 1) throw new Error("Document has no pages.");
  if (analysis.num_pages > MAX_PAGES) throw new Error(`Document has ${analysis.num_pages} pages, exceeds the maximum of ${MAX_PAGES}. Split the document first.`);

  return { pdfPath, cleanupPath, analysis };
}
