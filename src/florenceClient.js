// src/florenceClient.js
// Client for the existing Florence-2 Modal apps (figure_extraction/florence.py
// and florence_pdf.py). Used by mode 1 (hybrid-florence) for figure detection.
//
// The whole-PDF endpoint is preferred (MODAL_PDF_EXTRACT_URL). If only the
// page-image endpoint is configured (MODAL_FLORENCE_URL), pages are rendered
// locally and sent in batches instead.

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { getPdfInfo } from "./render.js";

const execFileAsync = promisify(execFile);

const postJson = async (url, body, headers, timeoutMs = 900_000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Detect figures and OCR tokens in a PDF using the deployed Modal Florence app.
 * @returns {Promise<{pages: Array<{page:number, detections:Array<{bbox:Array<number>, label:string, caption:string}>, ocr: {ocr_text:string, ocr_with_region:Array<{text:string, bbox:Array<number>}>}|null, page_error?:string}>, source:string}>}
 */
export async function detectInPdf({ pdfPath, pdfBytes, dpi, config, logger }) {
  const secret = config.florence.apiSecret;
  if (!secret) throw new Error("MODAL_API_SECRET is not set");

  if (config.florence.pdfUrl) {
    const body = { pdf_b64: Buffer.from(pdfBytes).toString("base64"), dpi };
    const resp = await postJson(
      config.florence.pdfUrl,
      body,
      { "Content-Type": "application/json", "X-API-Secret": secret },
    );
    if (resp.status === 401) throw new Error("Florence PDF endpoint rejected the request (401) — check MODAL_API_SECRET");
    if (!resp.ok) {
      const snippet = (await resp.text().catch(() => "")).slice(0, 200);
      throw new Error(`Florence PDF endpoint returned HTTP ${resp.status}: ${snippet}`);
    }
    const payload = await resp.json();
    const results = Array.isArray(payload.results) ? payload.results : [];
    const ocr = Array.isArray(payload.ocr) ? payload.ocr : [];
    const pages = results.map((entry, i) => ({
      page: i + 1,
      detections: Array.isArray(entry) ? entry : [],
      ocr: ocr[i] && typeof ocr[i] === "object" ? ocr[i] : null,
      page_error: Array.isArray(entry) ? undefined : (entry?.page_error ?? "unknown page error"),
    }));
    return { source: "pdf-endpoint", pages };
  }

  if (!config.florence.url) {
    throw new Error("hybrid-florence requires MODAL_PDF_EXTRACT_URL or MODAL_FLORENCE_URL in .env");
  }

  // Legacy per-page image endpoint: render pages to PNG and post in batches.
  const info = getPdfInfo(pdfPath);
  const pngBuffers = [];
  for (let page = 1; page <= info.pages; page += 1) {
    pngBuffers.push(await renderPagePng(pdfPath, page, dpi));
  }
  const batchSize = 4;
  const out = [];
  for (let start = 0; start < pngBuffers.length; start += batchSize) {
    const chunk = pngBuffers.slice(start, start + batchSize);
    const resp = await postJson(
      config.florence.url,
      { images: chunk.map((b) => b.toString("base64")) },
      { "Content-Type": "application/json", "X-API-Secret": secret },
    );
    if (resp.status === 401) throw new Error("Florence endpoint rejected the request (401) — check MODAL_API_SECRET");
    if (!resp.ok) {
      const snippet = (await resp.text().catch(() => "")).slice(0, 200);
      throw new Error(`Florence endpoint returned HTTP ${resp.status}: ${snippet}`);
    }
    const payload = await resp.json();
    const results = Array.isArray(payload.results) ? payload.results : [];
    const ocr = Array.isArray(payload.ocr) ? payload.ocr : [];
    for (let i = 0; i < chunk.length; i++) {
      const entry = results[i];
      out.push({
        page: start + i + 1,
        detections: Array.isArray(entry) ? entry : [],
        ocr: ocr[i] && typeof ocr[i] === "object" ? ocr[i] : null,
        page_error: Array.isArray(entry) ? undefined : (entry?.page_error ?? "unknown page error"),
      });
    }
  }
  return { source: "images-endpoint", pages: out };
}

async function renderPagePng(pdfPath, page, dpi) {
  const tmpDir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "florence-png-"));
  const prefix = path.join(tmpDir, "page");
  try {
    await execFileAsync("pdftoppm", ["-png", "-r", String(dpi), "-f", String(page), "-l", String(page), pdfPath, prefix], { maxBuffer: 64 * 1024 * 1024 });
    const file = fs.readdirSync(tmpDir).find((f) => f.endsWith(".png"));
    return fs.readFileSync(path.join(tmpDir, file));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
