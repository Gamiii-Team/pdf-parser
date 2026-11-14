// src/render.js
// Rendering and input-file handling. Uses the system poppler utilities
// (`pdfinfo`, `pdftoppm`) — no JS rasterizer dependency, works for PDFs.
// Image inputs (png/jpg/webp/gif) pass through untouched.

import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);

const IMAGE_MAGICS = [
  { ext: ".png", magic: [0x89, 0x50, 0x4e, 0x47] },
  { ext: ".jpg", magic: [0xff, 0xd8, 0xff] },
  { ext: ".jpeg", magic: [0xff, 0xd8, 0xff] },
  { ext: ".webp", magic: [0x52, 0x49, 0x46, 0x46] }, // RIFF....WEBP
  { ext: ".gif", magic: [0x47, 0x49, 0x46, 0x38] },
];

export function detectInputKind(filePath) {
  const buf = Buffer.alloc(12);
  const fd = fs.openSync(filePath, "r");
  fs.readSync(fd, buf, 0, 12, 0);
  fs.closeSync(fd);
  if (buf.slice(0, 5).toString("latin1").startsWith("%PDF")) return "pdf";
  for (const { magic } of IMAGE_MAGICS) {
    if (buf.slice(0, magic.length).equals(Buffer.from(magic))) return "image";
  }
  // Fall back to extension for webp/png that start with RIFF/etc.
  const ext = path.extname(filePath).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) return "image";
  if (ext === ".pdf") return "pdf";
  return "unknown";
}

export function getPdfInfo(pdfPath) {
  let out;
  try {
    out = execFileSync("pdfinfo", [pdfPath], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    throw new Error(`pdfinfo failed for ${pdfPath}: ${err.message}`);
  }
  const pagesMatch = out.match(/^Pages:\s+(\d+)/m);
  const sizeMatch = out.match(/^Page size:\s+([\d.]+)\s*x\s*([\d.]+)\s*pts/m);
  const pages = pagesMatch ? Number.parseInt(pagesMatch[1], 10) : 0;
  const width = sizeMatch ? Number.parseFloat(sizeMatch[1]) : 612;
  const height = sizeMatch ? Number.parseFloat(sizeMatch[2]) : 792;
  if (!pages) throw new Error(`pdfinfo: could not determine page count for ${pdfPath}`);
  return { pages, widthPt: width, heightPt: height };
}

/** Render a single page of a PDF to a JPEG buffer. */
export async function renderPage(pdfPath, pageNumber, { dpi, quality = 85, crop = null } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "pdf-render-"));
  const prefix = path.join(tmpDir, "page");
  const args = ["-r", String(dpi), "-f", String(pageNumber), "-l", String(pageNumber), "-jpeg", "-jpegopt", `quality=${quality}`];
  if (crop) {
    args.push("-x", String(crop.x), "-y", String(crop.y), "-W", String(crop.width), "-H", String(crop.height));
  }
  args.push(pdfPath, prefix);
  try {
    await execFileAsync("pdftoppm", args, { maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(`pdftoppm failed on page ${pageNumber} of ${pdfPath}: ${err.message}`);
  }
  const rendered = fs.readdirSync(tmpDir).find((f) => f.endsWith(".jpg"));
  if (!rendered) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(`pdftoppm produced no output for page ${pageNumber} of ${pdfPath}`);
  }
  const jpeg = fs.readFileSync(path.join(tmpDir, rendered));
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return jpeg;
}

/** Render all pages, honoring a per-page size ceiling (provider limits). */
export async function renderPdfPages(pdfPath, { dpi, maxBytes = 18 * 1024 * 1024 } = {}) {
  const info = getPdfInfo(pdfPath);
  const pages = [];
  for (let page = 1; page <= info.pages; page++) {
    let currentDpi = dpi;
    let jpeg = await renderPage(pdfPath, page, { dpi: currentDpi });
    if (jpeg.length > maxBytes && currentDpi > 72) {
      currentDpi = Math.max(72, Math.floor(currentDpi * 0.75));
      jpeg = await renderPage(pdfPath, page, { dpi: currentDpi });
    }
    pages.push({ page, dpi: currentDpi, jpeg, bytes: jpeg.length, overflow: jpeg.length > maxBytes });
  }
  return { info, pages };
}

/** Render top/bottom halves of an oversized page (with ~10% overlap). */
export async function renderPageHalves(pdfPath, pageNumber, { dpi } = {}) {
  const info = getPdfInfo(pdfPath);
  const scale = dpi / 72;
  const w = Math.round(info.widthPt * scale);
  const h = Math.round(info.heightPt * scale);
  const half = Math.floor(h / 2);
  const overlap = Math.floor(h * 0.05);
  const top = await renderPage(pdfPath, pageNumber, { dpi, crop: { x: 0, y: 0, width: w, height: half + overlap } });
  const bottom = await renderPage(pdfPath, pageNumber, { dpi, crop: { x: 0, y: half - overlap, width: w, height: h - half + overlap } });
  return {
    pageHeightPx: h,
    pageWidthPx: w,
    halves: [
      { half: "top", jpeg: top, yOffsetPx: 0, fraction: (half + overlap) / h },
      { half: "bottom", jpeg: bottom, yOffsetPx: half - overlap, fraction: (half + overlap) / h },
    ],
  };
}

export function toDataUrl(jpegBuffer, mime = "image/jpeg") {
  return `data:${mime};base64,${jpegBuffer.toString("base64")}`;
}

export function toBase64(buffer) {
  return buffer.toString("base64");
}
