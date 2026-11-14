// src/pymupdf/run.js
// Spawn the Python PyMuPDF worker and read its stdout JSON.
// The venv is auto-detected (REPO_ROOT/.venv/bin/python) so the user
// doesn't need to source it before running the CLI.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..", "..");

function findPython() {
  const candidates = [
    path.join(REPO_ROOT, ".venv", "bin", "python"),
    path.join(REPO_ROOT, ".venv", "Scripts", "python.exe"),
    process.env.PYTHON || null,
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      // try next
    }
  }
  // fall back to whatever `python3` is on PATH
  return "python3";
}

export async function spawnWorker(args, { maxBuffer = 256 * 1024 * 1024 } = {}) {
  const python = findPython();
  const worker = path.join(__dirname, "worker.py");
  let stdout, stderr;
  try {
    ({ stdout, stderr } = await execFileAsync(python, [worker, ...args], { maxBuffer }));
  } catch (err) {
    const msg = `${err?.stderr ?? ""}\n${err?.message ?? ""}`;
    if (/No module named ['"]?pymupdf['"]?/.test(msg)) {
      throw new Error(`PyMuPDF is not installed for '${python}'.\n  Hint: run 'npm run setup' (creates .venv and installs requirements.txt)`);
    }
    throw err;
  }
  if (stderr && stderr.trim()) {
    // Many pymupdf deprecation warnings appear on stderr; surface them only if stdout is empty
    if (!stdout.trim()) throw new Error(`PyMuPDF worker failed:\n${stderr}`);
  }
  return stdout;
}

export async function analyzePdf(pdfPath) {
  const out = await spawnWorker(["analyze", pdfPath]);
  return JSON.parse(out);
}

export async function cropRegion(pdfPath, page, x0, y0, x1, y1, dpi, outPath) {
  await spawnWorker(["crop", pdfPath, String(page), String(x0), String(y0), String(x1), String(y1), String(dpi), outPath]);
  return outPath;
}

export async function renderPage(pdfPath, page, dpi, outPath) {
  await spawnWorker(["render", pdfPath, String(page), String(dpi), outPath]);
  return outPath;
}
