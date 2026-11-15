#!/usr/bin/env node
// UI/server.mjs — localhost-only UI for the document→JSON pipeline.
// Reuses extractDocument() as-is; all output stays under out/ui/.
// Run folders are self-describing:
//   <runId>_<inputSlug>_<backend>-<modelSlug>  (see src/util/runName.js)
// Nothing here filters model errors — raw messages are returned to the UI.

import express from "express";
import multer from "multer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractDocument } from "../src/extractDocument.js";
import { config, missingFor, MAX_PAGES } from "../src/config.js";
import { createLogger } from "../src/util/log.js";
import { genRunId, formatRunFolder } from "../src/util/runName.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const UI_DIR = path.resolve(REPO, "UI");
const OUT_DIR = path.resolve(REPO, config.outputDir, "ui");
const UPLOAD_DIR = path.resolve(REPO, config.outputDir, ".ui-uploads");

const PORT = Number(process.env.PORT) || 3040;
const HOST = "127.0.0.1"; // hard-coded: single-user machine only

const SUPPORTED_EXTS = new Set([".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".webp", ".bmp"]);
const RUNS_ID = /^[0-9a-f]{8,20}$/;

const DEMOS = {
  "test.pdf": { path: path.join(REPO, "test.pdf"), name: "test.pdf", kind: "born-digital", tokens: "free (text-layer) + optional model calls" },
  "fixtures/scanned.pdf": { path: path.join(REPO, "fixtures", "scanned.pdf"), name: "scanned.pdf", kind: "scanned", tokens: "calls VLM — costs tokens" },
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- helpers ----------
function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function listRuns() {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(OUT_DIR, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(OUT_DIR, e.name);
    const manifest = readJsonSafe(path.join(dir, "manifest.json"));
    if (!manifest) continue;
    const report = readJsonSafe(path.join(dir, "run-report.json"));
    const meta = readJsonSafe(path.join(dir, "ui-meta.json"));
    if (meta && meta.runId) {
      out.push(meta);
      continue;
    }
    // No ui-meta.json: derive a run id from the folder name — leading segment
    // for the current scheme (<runId>_<input>_<backend>-<model>), trailing segment for the
    // short-lived timestamped scheme (<ts>_..._<runId>).
    const segments = e.name.split("_").filter(Boolean);
    const derived = RUNS_ID.test(segments[segments.length - 1]) ? segments[segments.length - 1]
      : RUNS_ID.test(segments[0]) ? segments[0]
      : null;
    if (!derived) continue;
    out.push({
      runId: derived,
      created: 0,
      input: path.basename(manifest.source_file ?? e.name),
      backend: "unknown",
      pages: manifest.pages ?? null,
      sections: null,
      tokens: null,
      duration_ms: report?.duration_ms ?? null,
      dir: dir,
    });
  }
  out.sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  return out;
}

function findRunDir(runId) {
  if (!RUNS_ID.test(runId)) return null;
  const entries = fs.readdirSync(OUT_DIR, { withFileTypes: true });
  // Timestamped scheme (briefly used): runId is the trailing segment.
  for (const e of entries) {
    if (e.isDirectory() && e.name.endsWith(`_${runId}`)) return path.join(OUT_DIR, e.name);
  }
  // Current and original legacy scheme: runId is the leading segment.
  for (const e of entries) {
    if (e.isDirectory() && e.name.startsWith(`${runId}_`)) return path.join(OUT_DIR, e.name);
  }
  // Fallback: match on ui-meta.json contents.
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(OUT_DIR, e.name);
    const meta = readJsonSafe(path.join(dir, "ui-meta.json"));
    if (meta?.runId === runId) return dir;
  }
  return null;
}

// ---------- app ----------
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
  fileFilter(_req, file, cb) {
    const ext = path.extname(file.originalname ?? "").toLowerCase();
    cb(null, SUPPORTED_EXTS.has(ext));
  },
});

app.use(express.static(UI_DIR));

app.get("/", (_req, res) => res.sendFile(path.join(UI_DIR, "index.html")));

// --- status: live, read-only view of configuration ---
app.get("/api/status", (_req, res) => {
  const backend = config.modelBackend;
  const missing = missingFor({});
  res.json({
    ok: missing.length === 0,
    backend,
    model: backend === "groq" ? config.groqModel : config.modalModel,
    missing,
    maxPages: MAX_PAGES,
    dpi: config.dpi,
    limits: { maxFileMb: 50, maxPages: MAX_PAGES },
    figurePassDefault: true,
    supportedExts: [...SUPPORTED_EXTS],
    keys: {
      GROQ_API_KEY: config.groqApiKey ? "••••set" : "",
      VLLM_ENDPOINT_URL: config.modalEndpointUrl ? "••••set" : "",
      VLLM_API_TOKEN: config.modalApiToken ? "••••set" : "",
      VLLM_MODEL: config.modalModel,
    },
    node: process.version,
    host: `${HOST}:${PORT}`,
  });
});

// --- demo registry ---
app.get("/api/demos", (_req, res) => {
  res.json({
    demos: Object.entries(DEMOS).map(([id, d]) => ({
      id,
      name: d.name,
      kind: d.kind,
      tokens: d.tokens,
      exists: fs.existsSync(d.path),
    })),
  });
});

// --- run the pipeline on an upload or a demo ---
app.post("/api/analyze", upload.single("file"), async (req, res) => {
  let pdfPath = null;
  let cleanupPath = null;
  try {
    const body = req.body ?? {};
    const demo = typeof body.demo === "string" ? body.demo.trim() : null;

    if (demo) {
      const d = DEMOS[demo];
      if (!d) return res.status(400).json({ error: `Unknown demo: ${demo}. Allowed: ${Object.keys(DEMOS).join(", ")}` });
      if (!fs.existsSync(d.path)) return res.status(400).json({ error: `Demo not found: ${d.path}` });
      pdfPath = d.path;
    } else if (req.file) {
      const ext = path.extname(req.file.originalname ?? "").toLowerCase();
      if (!SUPPORTED_EXTS.has(ext)) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: `Unsupported file type: ${ext}. Supported: ${[...SUPPORTED_EXTS].join(" ")}` });
      }
      pdfPath = req.file.path;
      cleanupPath = req.file.path;
    } else {
      return res.status(400).json({ error: "Provide either a file field (multipart) or demo: 'test.pdf' | 'fixtures/scanned.pdf'" });
    }

    const bool = (v, fallback) => v == null ? fallback : v === true || v === "true";
    const modelBackend = ["groq", "modal"].includes(String(body.modelBackend)) ? String(body.modelBackend) : undefined;

    const activeBackend = modelBackend ?? config.modelBackend;
    const activeModel = activeBackend === "groq" ? config.groqModel : config.modalModel;
    // For uploads pdfPath is a multer temp path with a random name — the client's
    // original filename is what belongs in the folder name and ui-meta.json.
    // Demos use their registry name instead.
    const inputName = demo
      ? path.basename(DEMOS[demo]?.name ?? demo)
      : (req.file?.originalname ?? path.basename(pdfPath ?? "input"));

    const runId = genRunId();
    const created = Date.now();
    const outName = formatRunFolder({
      backend: activeBackend,
      model: activeModel,
      inputName,
      runId,
    });
    const outDir = path.join(OUT_DIR, outName);

    const logger = createLogger({ silent: true });
    const { manifest, report } = await extractDocument(pdfPath, {
      out: outDir,
      logger,
      modelBackend,
      runId,
      forceVlm: bool(body.forceVlm, false),
      subject: typeof body.subject === "string" && body.subject.trim() ? body.subject.trim() : undefined,
      subjectDetect: bool(body.subjectDetect, true),
      figurePass: bool(body.figurePass, true),
    });

    fs.writeFileSync(path.join(outDir, "ui-meta.json"), JSON.stringify({
      runId,
      created,
      input: inputName,
      source: demo ? "demo" : "upload",
      demo: demo ?? null,
      backend: activeBackend,
      model: activeModel,
      pages: manifest.pages,
      sections: null,
      tokens: { input: report.total_tokens_input, output: report.total_tokens_output },
      blocks: report.blocks,
      duration_ms: report.duration_ms,
      dir: outDir,
    }, null, 2));

    res.json({ ok: true, runId, manifest, report, outDir });
  } catch (err) {
    // No filtering: return the raw error, the UI renders it verbatim.
    res.status(500).json({ error: String(err?.message ?? err), stack: String(err?.stack ?? "") });
  } finally {
    if (cleanupPath) { try { fs.unlinkSync(cleanupPath); } catch {} }
  }
});

// --- history ---
app.get("/api/runs", (_req, res) => res.json({ runs: listRuns() }));

app.get("/api/runs/:id", (req, res) => {
  const dir = findRunDir(req.params.id);
  if (!dir) return res.status(404).json({ error: "run not found" });
  const manifest = readJsonSafe(path.join(dir, "manifest.json"));
  const report = readJsonSafe(path.join(dir, "run-report.json"));
  const meta = readJsonSafe(path.join(dir, "ui-meta.json"));
  if (!manifest) return res.status(404).json({ error: "run manifest missing" });
  res.json({ manifest, report, meta, dir });
});

app.get("/api/runs/:id/report", (req, res) => {
  const dir = findRunDir(req.params.id);
  if (!dir) return res.status(404).json({ error: "run not found" });
  const report = readJsonSafe(path.join(dir, "run-report.json"));
  if (!report) return res.status(404).json({ error: "run-report.json missing" });
  res.json(report);
});

app.delete("/api/runs/:id", (req, res) => {
  const dir = findRunDir(req.params.id);
  if (!dir) return res.status(404).json({ error: "run not found" });
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(OUT_DIR + path.sep)) return res.status(500).json({ error: "path safety check failed" });
  fs.rmSync(resolved, { recursive: true, force: true });
  res.json({ ok: true });
});

app.listen(PORT, HOST, () => {
  console.log(`UI → http://${HOST}:${PORT}   (localhost only)`);
});
