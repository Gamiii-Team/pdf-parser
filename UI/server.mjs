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
import { runPptxVlmDeck } from "../src/pptxVlmRun.js";
import { validatePptx } from "../src/input/pptxValidate.js";
import { makeProvider } from "../src/providers/index.js";
import { rerunFigures } from "../src/extract/slideVlm.js";
import { markCancelled } from "../src/pptxVlmRun.js";
import { validateSlide, stripReviewOnly, validateFigures as _validateFigures, validateTables as _validateTables } from "../src/validate/slideSchema.js";
void stripReviewOnly;
import { applyRerun, undoRerun } from "../src/slideMerge.js";
import { renderFigureCrop } from "../src/crop.js";
import { tiles2x2, mergeVisibleText, zoomTilesWithVlm } from "../src/zoom.js";
import { mergeSlides, writeMainAtomic } from "../src/mergeMain.js";
import { config, missingFor, MAX_PAGES } from "../src/config.js";
import { createLogger } from "../src/util/log.js";
import { genRunId, formatRunFolder, stripExt } from "../src/util/runName.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const UI_DIR = path.resolve(REPO, "UI");
const OUT_DIR = path.resolve(REPO, config.outputDir, "ui");
const UPLOAD_DIR = path.resolve(REPO, config.outputDir, ".ui-uploads");

const PORT = Number(process.env.PORT) || 3040;
const HOST = "127.0.0.1"; // hard-coded: single-user machine only

const SUPPORTED_EXTS = new Set([".pdf", ".pptx", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".webp", ".bmp"]);
const RUNS_ID = /^[0-9a-f]{8,20}$/;

const DEMOS = {
  "test.pdf": { path: path.join(REPO, "test.pdf"), name: "test.pdf", kind: "born-digital", tokens: "free (text-layer) + optional model calls" },
  "fixtures/scanned.pdf": { path: path.join(REPO, "fixtures", "scanned.pdf"), name: "scanned.pdf", kind: "scanned", tokens: "calls VLM — costs tokens" },
  "fixtures/sample.pptx": { path: path.join(REPO, "fixtures", "sample.pptx"), name: "sample.pptx", kind: "pptx", tokens: "LibreOffice conversion, then text-layer + optional model calls" },
};

// ---------- in-memory job status (for a future async UI) ----------
// /api/analyze today is synchronous (the UI expects the manifest inline). The
// job record exists so a future async UI can poll these endpoints without
// reworking the API surface. Stages: queued → converting → analyzing → done | failed.
const JOBS_TTL_MS = 60 * 60 * 1000;
const JOBS_MAX = 200;
const jobs = new Map(); // jobId → job

function sweepJobs() {
  const cutoff = Date.now() - JOBS_TTL_MS;
  for (const [id, j] of jobs) {
    if (j.updated < cutoff) jobs.delete(id);
  }
  while (jobs.size > JOBS_MAX) {
    let oldestId = null, oldestAt = Infinity;
    for (const [id, j] of jobs) if (j.created < oldestAt) { oldestAt = j.created; oldestId = id; }
    if (oldestId == null) break;
    jobs.delete(oldestId);
  }
}

function createJob(input, source) {
  sweepJobs();
  const job = { id: genRunId(), input, source, status: "queued", stage: null, created: Date.now(), updated: Date.now(), error: null, runId: null };
  jobs.set(job.id, job);
  return job;
}

function setJob(job, patch) {
  if (!job) return;
  Object.assign(job, patch, { updated: Date.now() });
}

// ---------- VLM-mode jobs (out/vlm/<jobId>/<mode>/<modelSlug>/) ----------
const VLM_JOB_ROOT = path.resolve(REPO, config.outputDir, "vlm");
const VLM_JOB_TTL_MS = 24 * 60 * 60 * 1000;
const VLM_ID = /^[0-9a-f]{16}$/;

function vlmJobDir(jobId) {
  if (!VLM_ID.test(String(jobId))) return null;
  const root = path.join(VLM_JOB_ROOT, jobId);
  if (!fs.existsSync(root)) return null;
  const modeDir = fs.readdirSync(root, { withFileTypes: true }).find((e) => e.isDirectory());
  if (!modeDir) return null;
  const modePath = path.join(root, modeDir.name);
  const modelDir = fs.readdirSync(modePath, { withFileTypes: true }).find((e) => e.isDirectory());
  return modelDir ? path.join(modePath, modelDir.name) : null;
}

function readVlmJob(jobId) {
  const dir = vlmJobDir(jobId);
  if (!dir) return null;
  const status = readJsonSafe(path.join(dir, "status.json"));
  const result = readJsonSafe(path.join(dir, "result.json"));
  const report = readJsonSafe(path.join(dir, "run-report.json"));
  const hints = readJsonSafe(path.join(dir, "hints.json"));
  if (!status && !result) return null;
  return { id: String(jobId), dir, mode: "vlm", status, result, report, hints, slidesDir: path.join(dir, "slides") };
}

/** Remove vlm job folders older than the TTL. Best-effort; call at boot and on listings. */
function sweepVlmJobs() {
  try {
    for (const e of fs.readdirSync(VLM_JOB_ROOT, { withFileTypes: true })) {
      if (!e.isDirectory() || !VLM_ID.test(e.name)) continue;
      const root = path.join(VLM_JOB_ROOT, e.name);
      const stat = fs.statSync(root);
      if (Date.now() - stat.mtimeMs > VLM_JOB_TTL_MS) fs.rmSync(root, { recursive: true, force: true });
    }
  } catch { /* root may not exist yet */ }
}

function listVlmJobs() {
  sweepVlmJobs();
  const out = [];
  try {
    for (const e of fs.readdirSync(VLM_JOB_ROOT, { withFileTypes: true })) {
      if (!e.isDirectory() || !VLM_ID.test(e.name)) continue;
      const job = readVlmJob(e.name);
      if (!job) continue;
      out.push({
        id: job.id, mode: "vlm",
        input: job.result?.input ?? job.status?.input ?? "input",
        model: job.result?.model ?? job.status?.model ?? null,
        status: job.status?.status ?? "unknown",
        created: job.status?.created ?? fs.statSync(path.join(VLM_JOB_ROOT, e.name)).mtimeMs,
        updated: job.status?.updated ?? null,
        slides: job.result?.slides?.length ?? null,
      });
    }
  } catch { /* root may not exist */ }
  return out;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(VLM_JOB_ROOT, { recursive: true });

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
sweepVlmJobs(); // one sweep at boot; listVlmJobs re-sweeps lazily

// Rebuild main.json atomically from the on-disk result+status.
// Called whenever per-slide state changes so export is never stale.
function rebuildMain(vlm) {
  try {
    const result = readJsonSafe(path.join(vlm.dir, "result.json"));
    const status = readJsonSafe(path.join(vlm.dir, "status.json"));
    if (!result || !status) return null;
    return mergeSlides(result, status.slides ?? {});
  } catch (err) {
    console.error("rebuildMain failed:", err);
    return null;
  }
}

/** Normalize the persisted slides map into the queue vocabulary. */
function normalizeSlideStatuses(raw, slides) {
  const map = {};
  for (const slide of slides ?? []) {
    const n = slide?.slide;
    if (n == null) continue;
    const v = raw?.[n];
    map[n] = (v === "approved" || v === "queued" || v === "auto" || v === "failed") ? v
      : slide.failed ? "failed"
      : slide.tables?.length || slide.figures?.length ? "queued"
      : "auto";
  }
  return map;
}

function renderMainJson(vlm) {
  const merged = rebuildMain(vlm);
  if (!merged) return null;
  const main = writeMainAtomic(vlm.dir, merged);
  return merged;
}

const app = express();
// Track slides currently inside re-run/zoom so Approve can refuse until they finish.
const rerunsInFlight = new Set();
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename(_req, file, cb) {
      // multer's default random name loses the extension — but the pipeline
      // routes on path.extname(pdfPath), so keep it (sanitized).
      const ext = path.extname(file.originalname ?? "").toLowerCase().replace(/[^a-z0-9.]/g, "");
      cb(null, `${genRunId()}${ext}`);
    },
  }),
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
// Full-VLM mode (PPTX only, async): validate synchronously, respond 202 with
// jobId, run conversion+VLM in the background. Client polls /api/jobs/:id and
// lands on /review.html?id=<jobId>.
async function handleVlmAnalyze(req, res) {
  let cleanupPath = null;
  try {
    const body = req.body ?? {};
    const demo = typeof body.demo === "string" ? body.demo.trim() : null;
    let pptxPath;
    let inputName;
    if (demo) {
      const d = DEMOS[demo];
      if (!d) return res.status(400).json({ error: `Unknown demo: ${demo}. Allowed: ${Object.keys(DEMOS).join(", ")}` });
      if (path.extname(d.path).toLowerCase() !== ".pptx") return res.status(400).json({ error: "--mode vlm requires a .pptx input" });
      if (!fs.existsSync(d.path)) return res.status(400).json({ error: `Demo not found: ${d.path}` });
      pptxPath = d.path; inputName = d.name;
    } else if (req.file) {
      const ext = path.extname(req.file.originalname ?? "").toLowerCase();
      if (ext !== ".pptx") { fs.unlinkSync(req.file.path); return res.status(400).json({ error: `--mode vlm requires a .pptx input (got ${ext || "unknown"})` }); }
      pptxPath = req.file.path; inputName = req.file.originalname ?? "input.pptx"; cleanupPath = req.file.path;
    } else {
      return res.status(400).json({ error: "Provide a file field (multipart) or demo: 'fixtures/sample.pptx'" });
    }

    // Validate synchronously so bad files get an immediate 400.
    try { await validatePptx(pptxPath); } catch (err) {
      if (cleanupPath) try { fs.unlinkSync(cleanupPath); } catch {}
      return res.status(400).json({ error: String(err?.message ?? err) });
    }

    const missing = missingFor({ modelBackend: "groq" });
    if (missing.length) {
      if (cleanupPath) try { fs.unlinkSync(cleanupPath); } catch {}
      return res.status(400).json({ error: `vlm mode needs a working Groq backend (or GROQ_API_KEY): ${missing.join(", ")}` });
    }

    const jobId = genRunId();
    res.status(202).json({ ok: true, mode: "vlm", jobId, status: "queued" });

    runPptxVlmDeck(pptxPath, { jobId, logger: { info() {}, warn() {}, error() {} } })
      .then(() => { if (cleanupPath) try { fs.unlinkSync(cleanupPath); } catch {} })
      .catch((err) => {
        // Overwrite status best-effort so the review screen can surface the failure.
        try {
          const dir = vlmJobDir(jobId);
          if (dir) fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({
            id: jobId, mode: "vlm", model: config.groqModel, input: path.basename(inputName),
            created: Date.now(), updated: Date.now(), status: "failed",
            error: String(err?.message ?? err), slides: {}, issues: [String(err?.message ?? err)],
          }, null, 2));
        } catch { /* partial folder; UI will see failed state or 404 */ }
        if (cleanupPath) try { fs.unlinkSync(cleanupPath); } catch {}
      });
  } catch (err) {
    const isInputErr = err?.code === "PPTX_INVALID" || err?.name === "PptxValidationError";
    const status = isInputErr ? 400 : 500;
    const payload = isInputErr
      ? { error: String(err?.message ?? err) }
      : { error: String(err?.message ?? err), stack: String(err?.stack ?? "") };
    if (cleanupPath) try { fs.unlinkSync(cleanupPath); } catch {}
    return res.status(status).json(payload);
  }
}

app.post("/api/analyze", upload.single("file"), async (req, res) => {
  const bodyMode = String((req.body ?? {}).mode ?? "").trim().toLowerCase();
  const envMode = String(process.env.PPTX_MODE ?? "").trim().toLowerCase();
  const wantsVlm = bodyMode === "vlm" || (!bodyMode && envMode === "vlm");
  if (wantsVlm) return handleVlmAnalyze(req, res);

  let pdfPath = null;
  let cleanupPath = null;
  let job = null;
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

    job = createJob(inputName, demo ? "demo" : "upload");
    setJob(job, { status: "running", stage: "queued" });

    const logger = createLogger({ silent: true });
    const { manifest, report } = await extractDocument(pdfPath, {
      out: outDir,
      logger,
      modelBackend,
      runId,
      onStage: (stage) => setJob(job, { stage }),
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

    setJob(job, { status: "done", stage: "done", runId });
    res.json({ ok: true, runId, manifest, report, outDir, jobId: job.id });
  } catch (err) {
    if (job) setJob(job, { status: "failed", error: String(err?.message ?? err) });
    const isInputErr = err?.code === "PPTX_INVALID" || err?.code === "PPTX_CONVERT_FAILED";
    const status = isInputErr ? 400 : 500;
    // No filtering of 500s: raw error goes to the UI. 400s are friendly validation/conversion messages.
    const payload = isInputErr
      ? { error: String(err?.message ?? err), jobId: job?.id }
      : { error: String(err?.message ?? err), stack: String(err?.stack ?? ""), jobId: job?.id };
    res.status(status).json(payload);
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

app.get("/api/jobs", (_req, res) => {
  sweepJobs();
  const hybridJobs = [...jobs.values()].sort((a, b) => b.created - a.created);
  res.json({ jobs: [...hybridJobs, ...listVlmJobs()].sort((a, b) => (b.created ?? 0) - (a.created ?? 0)) });
});

// GET /api/jobs/:id — hybrid job (memory) or vlm job (disk fallback so review survives restarts)
app.get("/api/jobs/:id", (req, res) => {
  sweepJobs();
  const hybrid = jobs.get(req.params.id);
  if (hybrid) return res.json({ job: hybrid });
  const vlm = readVlmJob(req.params.id);
  if (!vlm) return res.status(404).json({ error: "job not found" });
  const statusObj = readJsonSafe(path.join(vlm.dir, "status.json"));
  const statuses = normalizeSlideStatuses(statusObj?.slides, vlm.result?.slides ?? []);
  const queue = Object.keys(statuses).filter((n) => statuses[n] === "queued" || statuses[n] === "failed").map(Number).sort((a, b) => a - b);
  const skipped = Object.keys(statuses).filter((n) => statuses[n] === "auto").map(Number).sort((a, b) => a - b);
  const created = vlm.result?.created ?? statusObj?.created ?? null;
  const done = Object.values(statuses).filter((s) => (s === "done") || (s === "approved") || (s === "reviewing") || (s === "auto") || (s === "failed") || (s === "queued")).length;
  const queuedCount = Object.values(statuses).filter((s) => s === "queued").length;
  res.json({
    job: {
      id: vlm.id, mode: "vlm",
      input: vlm.result?.input ?? statusObj?.input ?? "input",
      model: vlm.result?.model ?? statusObj?.model ?? null,
      status: statusObj?.status ?? "unknown",
      stage: statusObj?.status ?? null,
      created, updated: statusObj?.updated ?? created,
      error: statusObj?.error ?? null,
      slides: vlm.result?.slides?.length ?? 0,
      issues: statusObj?.issues ?? [],
      outDir: vlm.dir,
      queue,
      skipped,
      statuses,
      progress: { done, total: vlm.result?.slides?.length ?? 0, queued: queuedCount },
    },
    result: vlm.result,
    report: vlm.report,
  });
});

// GET a server-generated crop preview of figure i (normalized box from source.pdf)
app.get("/api/jobs/:id/slides/:n/crop/:i", async (req, res) => {
  if (!VLM_ID.test(req.params.id)) return res.status(400).json({ error: "invalid job id" });
  const vlm = readVlmJob(req.params.id);
  if (!vlm || !vlm.result) return res.status(404).json({ error: "job result not found" });
  const n = Number.parseInt(req.params.n, 10);
  const figIdx = Number.parseInt(req.params.i, 10);
  if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: "slide number out of range" });
  if (!Number.isInteger(figIdx) || figIdx < 0) return res.status(400).json({ error: "figure index out of range" });
  const slide = vlm.result?.slides?.[n - 1];
  const fig = slide?.figures?.[figIdx];
  if (!slide || !fig) return res.status(404).json({ error: "figure not found" });
  if (!Array.isArray(fig.bbox)) return res.status(400).json({ error: "figure has no bounding box — draw one first" });
  try {
    const outPng = path.join(vlm.dir, "crops", `preview-${figIdx}.png`);
    await renderFigureCrop(path.join(vlm.dir, "source.pdf"), n, fig.bbox, outPng, { pad: 0.03, dpi: 300 });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    fs.createReadStream(outPng).pipe(res);
  } catch (err) {
    res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// GET slide image for the review screen (validates id + slide range; never builds a path from raw client input)
app.get("/api/jobs/:id/slides/:n", (req, res) => {
  if (!VLM_ID.test(req.params.id)) return res.status(400).json({ error: "invalid job id" });
  const n = Number.parseInt(req.params.n, 10);
  if (!Number.isInteger(n) || n < 1 || n > 100) return res.status(400).json({ error: "slide number out of range" });
  const vlm = readVlmJob(req.params.id);
  if (!vlm) return res.status(404).json({ error: "job not found" });
  const file = path.join(vlm.slidesDir, `${String(n).padStart(2, "0")}.png`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: "slide image not found" });
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "private, max-age=86400");
  fs.createReadStream(file).pipe(res);
});

// PUT edited figures/tables for one slide — refuses approved slides.
// Body: { figures?: [...], tables?: [...] } (or a bare { json: { figures, tables } }) — everything else is preserved verbatim.
app.put("/api/jobs/:id/slides/:n", (req, res) => {
  if (!VLM_ID.test(req.params.id)) return res.status(400).json({ error: "invalid job id" });
  const n = Number.parseInt(req.params.n, 10);
  if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: "slide number out of range" });
  const vlm = readVlmJob(req.params.id);
  if (!vlm || !vlm.result) return res.status(404).json({ error: "job result not found" });
  const idx = n - 1;
  const current = vlm.result?.slides?.[idx];
  if (!current) return res.status(400).json({ error: `slide ${n} out of range` });

  const status = readJsonSafe(path.join(vlm.dir, "status.json"));
  if (status?.slides?.[n] === "approved") return res.status(409).json({ error: "slide is approved — reopen it first" });

  const body = req.body?.json ?? req.body ?? {};
  const figures = Array.isArray(body.figures) ? body.figures : [];
  const tables = Array.isArray(body.tables) ? body.tables : [];

  const figCheck = _validateFigures(figures);
  if (!figCheck.ok) return res.status(400).json({ error: "figures JSON failed schema validation: " + figCheck.errors.slice(0, 6).join("; ") });
  const tableCheck = _validateTables(tables);
  if (!tableCheck.ok) return res.status(400).json({ error: "tables JSON failed schema validation: " + tableCheck.errors.slice(0, 6).join("; ") });

  // Merge — title/text_blocks/speaker_notes/confidence/issues/etc. come from the stored slide verbatim.
  const slide = { ...current, figures, tables, failed: false, reviewed: false, rerun_count: current.rerun_count ?? 0, previous: undefined };
  delete slide.previous;
  // Auto slide gains a figure → it joins the queue.
  const hadAny = (current.figures?.length ?? 0) > 0 || (current.tables?.length ?? 0) > 0;
  const nowAny = figures.length > 0 || tables.length > 0;

  vlm.result.slides[idx] = slide;
  try {
    fs.writeFileSync(path.join(vlm.dir, "result.json"), JSON.stringify(vlm.result, null, 2));
    if (status) {
      status.updated = Date.now();
      let slideStatus = status.slides?.[n] ?? (nowAny ? "queued" : "auto");
      if (!hadAny && nowAny) slideStatus = "queued";
      status.slides = { ...(status.slides ?? {}), [n]: slideStatus };
      fs.writeFileSync(path.join(vlm.dir, "status.json"), JSON.stringify(status, null, 2));
    }
    const main = renderMainJson(vlm);
    res.json({ ok: true, slide, main: main ? { jobId: main.jobId, slides: main.slides.length } : null });
  } catch (err) {
    res.status(500).json({ error: String(err?.message ?? err) });
  }
});

const RERUN_LIMIT = 5;
const NOTE_LIMIT = 1000;
const isStr = (v) => typeof v === "string";

// POST re-run figures & tables for one slide (guided by a human reviewer).
// Body: { slideNote?: string, figureNotes?: [{ index: number, note: string }] }
app.post("/api/jobs/:id/slides/:n/rerun", async (req, res) => {
  if (!VLM_ID.test(req.params.id)) return res.status(400).json({ error: "invalid job id" });
  const n = Number.parseInt(req.params.n, 10);
  if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: "slide number out of range" });
  const vlm = readVlmJob(req.params.id);
  if (!vlm || !vlm.result) return res.status(404).json({ error: "job result not found" });
  const idx = n - 1;
  const current = vlm.result?.slides?.[idx];
  if (!current) return res.status(400).json({ error: `slide ${n} out of range` });
  if (current.failed) return res.status(422).json({ error: "slide analysis failed — re-run from the initial page instead" });
  const status0 = readJsonSafe(path.join(vlm.dir, "status.json"));
  if (status0?.slides?.[n] === "approved") return res.status(409).json({ error: "slide is approved — reopen it first" });
  rerunsInFlight.add(`${req.params.id}:${n}`);
  try {
    // Rate limit + note length caps
    const rerunCount = Number(current.rerun_count ?? 0);
    if (rerunCount >= RERUN_LIMIT) return res.status(429).json({ error: `re-run limit reached for slide ${n} (${RERUN_LIMIT}/slide)` });
  const slideNote = isStr(req.body?.slideNote) ? req.body.slideNote.slice(0, NOTE_LIMIT) : "";
  const rawFigureNotes = req.body?.figureNotes;
  const figureNotes = Array.isArray(rawFigureNotes)
    ? rawFigureNotes.map((fn) => ({ index: Number(fn?.index), note: String(fn?.note ?? "").slice(0, NOTE_LIMIT) })).filter((fn) => Number.isInteger(fn.index))
    : [];
  if ((isStr(req.body?.slideNote) ? req.body.slideNote.length : 0) > NOTE_LIMIT) {
    return res.status(400).json({ error: `slideNote exceeds the ${NOTE_LIMIT}-character limit` });
  }
  const total = vlm.result.slides.length;
  const hint = (vlm.hints ?? [])[idx] ?? null;

  const missing = missingFor({ modelBackend: "groq" });
  if (missing.length) return res.status(400).json({ error: `rerun needs a Groq backend: ${missing.join(", ")}` });
  const pngPath = path.join(vlm.slidesDir, `${String(n).padStart(2, "0")}.png`);
  if (!fs.existsSync(pngPath)) return res.status(400).json({ error: "slide image missing — cannot rerun" });

  try {
    // Render crops (≤2) for boxed target figures before calling the model — the
    // review screen encourages one box per figure; full slide + crops = ≤3 images/request.
    const figureIndexes = Array.isArray(req.body?.figureIndexes)
      ? req.body.figureIndexes.filter((i) => Number.isInteger(i) && i >= 0 && i < (current.figures?.length ?? 0))
      : null; // null = whole slide re-run (current behaviour)
    const cropDir = path.join(vlm.dir, "crops");
    const crops = [];
    if (figureIndexes && figureIndexes.length > 0) {
      for (const i of figureIndexes.slice(0, 2)) {
        const f = current.figures?.[i];
        if (!Array.isArray(f?.bbox)) continue;
        try {
          const outPng = path.join(cropDir, `rerun-${i}.png`);
          await renderFigureCrop(path.join(vlm.dir, "source.pdf"), n, f.bbox, outPng, { pad: 0.03, dpi: 300 });
          crops.push({ path: outPng, index: i, label: `Figure ${i + 1} crop` });
        } catch (e) { /* crop is a hint, not a requirement — fall back to whole-slide */ }
      }
    }
    const { figures, tables, usage: _u } = await rerunFigures({
      pngPath, currentSlide: current, slideNote, figureNotes,
      provider: makeProvider("groq"), logger: { info() {}, warn() {}, error() {} },
      crops,
    });
    const merged = applyRerun(current, { figures, tables }, hint);
    void _u;

    vlm.result.slides[idx] = merged;
    fs.writeFileSync(path.join(vlm.dir, "result.json"), JSON.stringify(vlm.result, null, 2));
    try {
      const status = readJsonSafe(path.join(vlm.dir, "status.json"));
      if (status) {
        status.updated = Date.now();
        status.slides = { ...(status.slides ?? {}), [n]: "done" };
        fs.writeFileSync(path.join(vlm.dir, "status.json"), JSON.stringify(status, null, 2));
      }
    } catch { /* best effort */ }
    res.json({ ok: true, slide: merged });
  } catch (err) {
    res.status(422).json({ error: String(err?.message ?? err) });
  } finally {
    rerunsInFlight.delete(`${req.params.id}:${n}`);
  }
  } finally {
    rerunsInFlight.delete(`${req.params.id}:${n}`);
  }
});

// POST zoom pass for one figure — split it into a 2x2 grid of tiles (10% overlap)
// and read each tile at high DPI, then merge visible_text (deduplicated).
// Counts as one re-run credit (rerun_count += 1, shared 5/slide cap).
app.post("/api/jobs/:id/slides/:n/zoom", async (req, res) => {
  if (!VLM_ID.test(req.params.id)) return res.status(400).json({ error: "invalid job id" });
  const n = Number.parseInt(req.params.n, 10);
  if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: "slide number out of range" });
  const vlm = readVlmJob(req.params.id);
  if (!vlm || !vlm.result) return res.status(404).json({ error: "job result not found" });
  const idx = n - 1;
  const current0 = vlm.result?.slides?.[idx];
  if (!current0) return res.status(400).json({ error: `slide ${n} out of range` });
  if (current0.failed) return res.status(422).json({ error: "slide analysis failed — re-run first" });
  if ((readJsonSafe(path.join(vlm.dir, "status.json"))?.slides?.[n]) === "approved") return res.status(409).json({ error: "slide is approved — reopen it first" });
  rerunsInFlight.add(`${req.params.id}:${n}`);
  try {
  const figIdx = Number.parseInt(req.body?.figureIndex, 10);
  const fig = current0.figures?.[figIdx];
  if (!Number.isInteger(figIdx) || figIdx < 0) return res.status(400).json({ error: "figureIndex must be a non-negative integer" });
  if (!fig) return res.status(404).json({ error: `figure ${figIdx + 1} not found on this slide` });
  if (!Array.isArray(fig.bbox)) return res.status(400).json({ error: "figure has no bounding box — draw one first" });

  const rerunCount = Number(current0.rerun_count ?? 0);
  if (rerunCount >= RERUN_LIMIT) return res.status(429).json({ error: `re-run limit reached for slide ${n} (${RERUN_LIMIT}/slide)` });

  const sourcePdf = path.join(vlm.dir, "source.pdf");
  if (!fs.existsSync(sourcePdf)) return res.status(400).json({ error: "source PDF no longer exists for this job" });

  const missing = missingFor({ modelBackend: "groq" });
  if (missing.length) return res.status(400).json({ error: `zoom needs a Groq backend: ${missing.join(", ")}` });

  const cropDir = path.join(vlm.dir, "crops");
  fs.mkdirSync(cropDir, { recursive: true });
  const logger = { info() {}, warn() {}, error() {} };
  const tileBoxes = tiles2x2(fig.bbox);
    const fullCrop = path.join(cropDir, `zoom-full-${figIdx}.png`);
    await renderFigureCrop(sourcePdf, n, fig.bbox, fullCrop, { pad: 0, dpi: 300, maxDim: 2048 });
    const tilePaths = [];
    for (const [i, tileBox] of tileBoxes.entries()) {
      const tilePng = path.join(cropDir, `zoom-tile-${figIdx}-${i}.png`);
      await renderFigureCrop(sourcePdf, n, tileBox, tilePng, { pad: 0, dpi: 300, maxDim: 2048 });
      tilePaths.push(tilePng);
    }
    const tileLists = await zoomTilesWithVlm({ provider: makeProvider("groq"), fullCropPath: fullCrop, tilePaths, logger });
    const mergedText = mergeVisibleText(fig.visible_text ?? [], tileLists);
    const failedTiles = tileLists.filter((l) => l.length === 0).length;
    const updated = {
      ...current0,
      figures: current0.figures.map((f, i) => (i === figIdx ? { ...f, visible_text: mergedText } : f)),
      rerun_count: rerunCount + 1,
    };
    if (failedTiles > 0) updated.issues = [...(updated.issues ?? []), `zoom: ${failedTiles} tile(s) unreadable`];
    vlm.result.slides[idx] = updated;
    fs.writeFileSync(path.join(vlm.dir, "result.json"), JSON.stringify(vlm.result, null, 2));
    try {
      const status = readJsonSafe(path.join(vlm.dir, "status.json"));
      if (status) {
        status.updated = Date.now();
        status.slides = { ...(status.slides ?? {}), [n]: "done" };
        fs.writeFileSync(path.join(vlm.dir, "status.json"), JSON.stringify(status, null, 2));
      }
    } catch { /* best effort */ }
    res.json({ ok: true, slide: updated, tilesProcessed: tileBoxes.length - failedTiles });
  } finally {
    rerunsInFlight.delete(`${req.params.id}:${n}`);
  }
});

// POST approve the current editor state (figures/tables) → merge into main.json atomically.
// Idempotent; refused while a re-run is in flight for this slide.
app.post("/api/jobs/:id/slides/:n/approve", async (req, res) => {
  if (!VLM_ID.test(req.params.id)) return res.status(400).json({ error: "invalid job id" });
  const n = Number.parseInt(req.params.n, 10);
  if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: "slide number out of range" });
  if (rerunsInFlight.has(`${req.params.id}:${n}`)) return res.status(409).json({ error: "re-run in progress for this slide — try again when it finishes" });
  const vlm = readVlmJob(req.params.id);
  if (!vlm || !vlm.result) return res.status(404).json({ error: "job result not found" });
  const idx = n - 1;
  const current = vlm.result?.slides?.[idx];
  if (!current) return res.status(400).json({ error: `slide ${n} out of range` });

  const status = readJsonSafe(path.join(vlm.dir, "status.json"));
  if (status?.slides?.[n] === "approved") {
    return res.json({ ok: true, slide: current, alreadyApproved: true, main: renderMainJson(vlm) });
  }

  const body = req.body?.json ?? req.body ?? {};
  const figures = Array.isArray(body.figures) ? body.figures : current.figures ?? [];
  const tables = Array.isArray(body.tables) ? body.tables : current.tables ?? [];
  const figCheck = _validateFigures(figures);
  if (!figCheck.ok) return res.status(400).json({ error: "figures JSON failed schema validation: " + figCheck.errors.slice(0, 6).join("; ") });
  const tableCheck = _validateTables(tables);
  if (!tableCheck.ok) return res.status(400).json({ error: "tables JSON failed schema validation: " + tableCheck.errors.slice(0, 6).join("; ") });

  const slide = { ...current, figures, tables, failed: false, reviewed: true, previous: undefined };
  delete slide.previous;
  vlm.result.slides[idx] = slide;
  try {
    fs.writeFileSync(path.join(vlm.dir, "result.json"), JSON.stringify(vlm.result, null, 2));
    if (status) {
      status.updated = Date.now();
      status.slides = { ...(status.slides ?? {}), [n]: "approved" };
      fs.writeFileSync(path.join(vlm.dir, "status.json"), JSON.stringify(status, null, 2));
    }
    const main = renderMainJson(vlm);
    res.json({ ok: true, slide, main: main ? { jobId: main.jobId, slides: main.slides.length } : null });
  } catch (err) {
    res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// POST reopen an approved slide for editing — its figures/tables go back to 'queued'.
app.post("/api/jobs/:id/slides/:n/reopen", (req, res) => {
  if (!VLM_ID.test(req.params.id)) return res.status(400).json({ error: "invalid job id" });
  const n = Number.parseInt(req.params.n, 10);
  if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: "slide number out of range" });
  const vlm = readVlmJob(req.params.id);
  if (!vlm || !vlm.result) return res.status(404).json({ error: "job result not found" });
  const idx = n - 1;
  if (!vlm.result?.slides?.[idx]) return res.status(400).json({ error: `slide ${n} out of range` });

  const status = readJsonSafe(path.join(vlm.dir, "status.json"));
  if (status?.slides?.[n] !== "approved") return res.status(400).json({ error: "slide is not approved" });
  status.updated = Date.now();
  status.slides = { ...(status.slides ?? {}), [n]: "queued" };
  fs.writeFileSync(path.join(vlm.dir, "status.json"), JSON.stringify(status, null, 2));
  const main = renderMainJson(vlm);
  res.json({ ok: true, main: main ? { jobId: main.jobId, slides: main.slides.length } : null });
});

// POST cancel an in-flight vlm job — marks queued/running tasks cancelled, writes status.json.
app.post("/api/jobs/:id/cancel", (req, res) => {
  if (!VLM_ID.test(req.params.id)) return res.status(400).json({ error: "invalid job id" });
  const vlm = readVlmJob(req.params.id);
  if (!vlm) return res.status(404).json({ error: "job not found" });
  const statusObj = readJsonSafe(path.join(vlm.dir, "status.json"));
  if (!statusObj || statusObj.status === "done" || statusObj.status === "failed") {
    return res.json({ ok: true, note: "nothing to cancel — job is already finished" });
  }
  markCancelled(req.params.id);
  statusObj.status = "failed";
  statusObj.error = "cancelled";
  statusObj.updated = Date.now();
  try { fs.writeFileSync(path.join(vlm.dir, "status.json"), JSON.stringify(statusObj, null, 2)); } catch {}
  res.json({ ok: true, cancelled: true });
});

// POST retry only the failed slides — re-runs them without touching approved ones.
app.post("/api/jobs/:id/retry-failed", async (req, res) => {
  if (!VLM_ID.test(req.params.id)) return res.status(400).json({ error: "invalid job id" });
  const vlm = readVlmJob(req.params.id);
  if (!vlm || !vlm.result) return res.status(404).json({ error: "job result not found" });
  const failed = vlm.result.slides.filter((s) => s?.failed).map((s) => s.slide);
  if (failed.length === 0) return res.json({ ok: true, retried: [] });
  // Re-do the cheap parts: keep the existing manifest as-is but re-run analysis for the failed slides only.
  // For now: mark those slides' analyze tasks pending again by setting a marker the UI can pick up;
  // full per-slide task retry is tracked in PPTX_VLM_IMPLEMENTATION.md §11.4.
  const statusObj = readJsonSafe(path.join(vlm.dir, "status.json")) ?? {};
  statusObj.issues = [...(statusObj.issues ?? []), `retry-failed: ${failed.join(", ")} — use Re-run on each slide individually (per-slide task retry pending implementation)`];
  statusObj.updated = Date.now();
  try { fs.writeFileSync(path.join(vlm.dir, "status.json"), JSON.stringify(statusObj, null, 2)); } catch {}
  res.json({ ok: true, retried: failed, note: "use per-slide Re-run for each failed slide" });
});

// POST undo the last re-run for one slide (restores previous figures/tables)
app.post("/api/jobs/:id/slides/:n/undo-rerun", (req, res) => {
  if (!VLM_ID.test(req.params.id)) return res.status(400).json({ error: "invalid job id" });
  const n = Number.parseInt(req.params.n, 10);
  if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: "slide number out of range" });
  const vlm = readVlmJob(req.params.id);
  if (!vlm || !vlm.result) return res.status(404).json({ error: "job result not found" });
  const idx = n - 1;
  const current = vlm.result?.slides?.[idx];
  if (!current) return res.status(400).json({ error: `slide ${n} out of range` });
  const restored = undoRerun(current);
  if (!restored) return res.status(400).json({ error: "nothing to undo — no re-run on this slide" });
  vlm.result.slides[idx] = restored;
  try {
    fs.writeFileSync(path.join(vlm.dir, "result.json"), JSON.stringify(vlm.result, null, 2));
    res.json({ ok: true, slide: restored });
  } catch (err) {
    res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// GET export — download the fully-merged deck JSON (main.json).
// Rebuilt on the fly from the persisted result+status, so it reflects latest approvals.
app.get("/api/jobs/:id/export", (req, res) => {
  if (!VLM_ID.test(req.params.id)) return res.status(400).json({ error: "invalid job id" });
  const vlm = readVlmJob(req.params.id);
  if (!vlm || !vlm.result) return res.status(404).json({ error: "job result not found" });
  const base = stripExt(vlm.result.input ?? "deck") || "deck";
  const main = mergeSlides(vlm.result, normalizeSlideStatuses(readJsonSafe(path.join(vlm.dir, "status.json"))?.slides, vlm.result.slides ?? []));
  const mainPath = writeMainAtomic(vlm.dir, main);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${base.replace(/[^a-zA-Z0-9._-]/g, "_")}.json"`);
  fs.createReadStream(mainPath).pipe(res);
});

// DELETE a vlm job and all its artifacts (slides, result, hints)
app.delete("/api/jobs/:id", (req, res) => {
  if (!VLM_ID.test(req.params.id)) return res.status(400).json({ error: "invalid job id" });
  const dir = vlmJobDir(req.params.id);
  if (!dir) return res.status(404).json({ error: "job not found" });
  const resolved = path.resolve(path.join(VLM_JOB_ROOT, req.params.id));
  if (!resolved.startsWith(VLM_JOB_ROOT + path.sep)) return res.status(500).json({ error: "path safety check failed" });
  fs.rmSync(resolved, { recursive: true, force: true });
  jobs.delete(req.params.id);
  res.json({ ok: true });
});

app.listen(PORT, HOST, () => {
  console.log(`UI → http://${HOST}:${PORT}   (localhost only)`);
});
