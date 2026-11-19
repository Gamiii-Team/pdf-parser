// src/pptxVlmRun.js — full-VLM PPTX → JSON mode.
// Validates the deck, pulls native hints, converts to PDF, renders slides,
// asks Groq (one request per slide), merges everything, and persists the job
// under out/vlm/<jobId>/<mode>/<model>/ (status.json, result.json, slides/,
// manifest.json). Hybrid mode is unaffected — this path is opt-in.

import fs from "node:fs";
import path from "node:path";

// Module-level set of job ids cancelled mid-run. Cancellation is honoured between
// VLM calls (best effort); in-flight model requests are not interrupted.
const cancelledJobs = new Set();
export function isCancelled(jobId) { return cancelledJobs.has(jobId); }
export function markCancelled(jobId) { cancelledJobs.add(jobId); }
export function clearCancelled(jobId) { cancelledJobs.delete(jobId); }

import { config, missingFor } from "./config.js";
import { validatePptx } from "./input/pptxValidate.js";
import { convertPptxToPdf } from "./input/pptxToPdf.js";
import { extractHints } from "./input/pptxHints.js";
import { extractSlidesVlm } from "./extract/slideVlm.js";
import { analyzePdf } from "./pymupdf/run.js";
import { makeProvider } from "./providers/index.js";
import { genRunId, modelSlug } from "./util/runName.js";
import { buildStatusSlideMap, mergeSlides, writeMainAtomic } from "./mergeMain.js";
import { recentTimings } from "./util/log.js";

function groupConsecutiveBullets(slidesBlocks) {
  // Per-slide: merge consecutive bullet text blocks into one list block.
  const out = [];
  let list = null;
  const flush = () => { if (list) out.push(list); list = null; };
  for (const b of slidesBlocks) {
    if (b.role === "bullet") {
      if (!list) list = { type: "list", items: [], level: b.level ?? 0, caption: null, needs_review: false };
      list.items.push(b.text);
    } else {
      flush();
      out.push(b);
    }
  }
  flush();
  return out;
}

function chartTypeFromNative(hint) {
  const raw = String(hint?.chart_type ?? "").toUpperCase();
  if (raw.includes("BAR") || raw.includes("COLUMN")) return "bar";
  if (raw.includes("LINE")) return "line";
  if (raw.includes("PIE") || raw.includes("DOUGHNUT")) return "pie";
  if (raw.includes("SCATTER")) return "scatter";
  return "other";
}

function slideToBlocks(slideJson, hint) {
  const blocks = [];
  const base = { page: slideJson.slide, caption: null, needs_review: false };
  if (slideJson.subtitle) blocks.push({ ...base, type: "text", content: String(slideJson.subtitle) });
  const tb = groupConsecutiveBullets(slideJson.text_blocks ?? []);
  for (const b of tb) {
    if (b.type === "list") blocks.push({ ...base, type: "list", items: b.items });
    else {
      const role = b.role ?? "body";
      if (role === "heading") blocks.push({ ...base, type: "heading", content: b.text, level: Math.max(2, Math.min(6, (b.level ?? 0) + 2)) });
      else if (role === "caption") blocks.push({ ...base, type: "text", content: b.text });
      else if (role === "footer" || role === "note") blocks.push({ ...base, type: "notes", content: b.text });
      else blocks.push({ ...base, type: "text", content: b.text });
    }
  }
  for (const t of slideJson.tables ?? []) {
    blocks.push({ ...base, type: "table", header_rows: (t.headers?.length ? 1 : 0), content: { columns: t.headers ?? [], rows: t.rows ?? [] } });
  }
  const hintCharts = hint?.charts ?? [];
  for (const [i, fig] of (slideJson.figures ?? []).entries()) {
    const chartHint = hintCharts[i];
    const hasData = Boolean(fig?.data?.series?.length);
    // Native hint boxes win the bbox slot when the figure lacks its own.
    const nativeBox = fig.bbox ?? chartHint?.bbox ?? null;
    blocks.push({
      ...base,
      type: "chart",
      chart_type: chartTypeFromNative(chartHint),
      title: fig.title ?? chartHint?.title ?? null,
      description: fig.description ?? null,
      content: fig.data ? { ...fig.data, ...(hasData ? {} : {}) } : null,
      estimates: hasData,
      needs_review: slideJson.confidence === "low" || !hasData,
      ...(nativeBox && !fig.bbox ? { bbox: nativeBox, bbox_source: "native" } : {}),
      ...(fig.bbox ? { bbox: fig.bbox, bbox_source: fig.bbox_source ?? "model" } : {}),
      ...(fig.bbox_locked ? { bbox_locked: true } : {}),
    });
  }
  if (slideJson.speaker_notes) blocks.push({ ...base, type: "notes", content: slideJson.speaker_notes, caption: "Speaker notes" });
  return blocks;
}

export async function runPptxVlmDeck(input, options = {}) {
  if (path.extname(input).toLowerCase() !== ".pptx") {
    throw new Error("--mode vlm is only supported for .pptx inputs (PDF and images always use hybrid mode)");
  }
  const backend = "groq"; // vlm mode is pinned to Groq's qwen3.8-27b (see README)
  const missing = options.provider ? [] : missingFor({ modelBackend: backend });
  if (missing.length) throw new Error(`Missing configuration for vlm mode (groq): ${missing.join(", ")}`);

  const logger = options.logger ?? console;
  const onStatus = options.onStatus ?? (() => {});
  const t0 = Date.now();
  const jobId = options.jobId ?? genRunId();
  const model = config.groqModel;
  const outDir = path.resolve(path.join(config.outputDir, "vlm", jobId, "vlm", modelSlug(model)));
  const slidesDir = path.join(outDir, "slides");
  const manifestPath = path.join(outDir, "manifest.json");
  const resultPath = path.join(outDir, "result.json");
  const statusPath = path.join(outDir, "status.json");
  const reportPath = path.join(outDir, "run-report.json");
  fs.mkdirSync(slidesDir, { recursive: true });

  const status = {
    id: jobId, mode: "vlm", model, input: path.basename(input),
    created: Date.now(), updated: Date.now(), status: "analyzing",
    slides: {}, issues: [],
  };
  const writeStatus = (patch = {}) => {
    Object.assign(status, patch, { updated: Date.now() });
    fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
  };
  writeStatus({ status: "analyzing" });

  const provider = options.provider ?? makeProvider(backend);
  const validation = await validatePptx(input); // throws PptxValidationError on any violation
  const [{ analysis }, hintsResult] = await Promise.all([
    (async () => {
      onStatus({ stage: "converting" });
      const converted = await convertPptxToPdf(input, { logger, hideEmptySlides: (validation.empty ?? 0) > 0 });
      // Keep the converted PDF in the job folder for the crop pipeline ("source.pdf")
      // and delete it with the job (24h sweep or explicit delete).
      fs.mkdirSync(outDir, { recursive: true });
      fs.copyFileSync(converted.pdfPath, path.join(outDir, "source.pdf"));
      const analysis = await analyzePdf(converted.pdfPath);
      try { fs.unlinkSync(converted.pdfPath); } catch {}
      return { analysis };
    })(),
    extractHints(input, { logger }),
  ]);

  const hints = hintsResult.hints ?? [];
  const visible = hints.filter((h) => !h?.hidden && !h?.empty);
  const hintsAttach = visible.length === (analysis.num_pages ?? 0);
  const hintsForPages = hintsAttach ? visible : [];
  if (!hintsAttach) {
    status.issues.push(`native hints unavailable or misaligned (visible slides=${visible.length}, pdf pages=${analysis.num_pages}) — using image + text layer only`);
    logger?.warn?.(status.issues[0]);
    writeStatus();
  }

  const pages = (analysis.pages ?? []).slice(0, 25);
  // STALL DETECTION + PER-SLIDE PROGRESS LOGGING
  let lastProgressAt = Date.now();
  const stallMs = (config.jobStallMinutes ?? 5) * 60 * 1000;
  const stallWatchdog = setInterval(() => {
    if (status.status === "done" || status.status === "failed" || status.status === "review") { clearInterval(stallWatchdog); return; }
    if (Date.now() - lastProgressAt > stallMs) {
      status.status = "failed";
      status.error = `stalled: ${Math.round((Date.now() - lastProgressAt) / 60000)} minutes with no task completing`;
      status.updated = Date.now();
      writeStatus();
      clearInterval(stallWatchdog);
    }
  }, 30_000); // check every 30s
  stallWatchdog.unref?.();

  const onSlideStatus = (n, s) => { lastProgressAt = Date.now(); status.slides[n] = s; writeStatus(); };

  const { slides, usage, images, failed } = await extractSlidesVlm({
    pdfPath: path.join(outDir, "source.pdf"), pages, hints: hintsForPages, provider, slidesDir, logger,
    concurrency: Number(process.env.VLM_CONCURRENCY) || 3,
    dpi: Number(process.env.PPTX_VLM_DPI) || 150,
    onSlideStatus,
    cancelRequested: () => cancelledJobs.has(jobId),
  });
  clearInterval(stallWatchdog);
  if (cancelledJobs.has(jobId)) {
    status.status = "failed";
    status.error = "cancelled";
    status.updated = Date.now();
    writeStatus();
    throw new Error("job cancelled");
  }

  // ─── merge slides into the manifest shape ───
  const sections = slides.map((s) => {
    const n = s.slide;
    if (s.failed) {
      return {
        id: `s${String(n).padStart(3, "0")}`, heading: `Slide ${n} — analysis failed`, level: 1,
        pages: [n], content: [{ page: n, bbox: null, caption: "slide analysis failed", needs_review: true, type: "notes", content: s.issues?.[0] ?? "VLM analysis failed" }], subsections: [],
      };
    }
    const blocks = slideToBlocks(s.json, hintsForPages[n - 1] ?? null);
    const withIds = blocks.map((b, i) => ({ ...b, id: `b${String(n).padStart(3, "0")}-${String(i + 1).padStart(2, "0")}` }));
    return {
      id: `s${String(n).padStart(3, "0")}`,
      heading: s.json.title ? String(s.json.title) : `Slide ${n}`,
      level: 1, pages: [n],
      content: withIds,
      subsections: [],
    };
  });

  const manifest = {
    id: `doc_${Date.now().toString(16)}`,
    subject: "unknown",
    subject_source: "unavailable",
    source_file: path.resolve(input),
    pages: analysis.num_pages,
    sections,
  };
  const report = {
    run_id: jobId, mode: "vlm", model, backend,
    source_file: path.resolve(input),
    duration_ms: Date.now() - t0,
    pages: analysis.num_pages,
    slides: { total: analysis.num_pages, failed, per_slide: status.slides },
    total_tokens_input: usage.input, total_tokens_output: usage.output,
    images_sent: images,
    pptx: { total: 0, visible: analysis.num_pages, hidden: validation.hidden ?? 0, empty: validation.empty ?? 0 },
    errors: { vlm: slides.filter((s) => s.failed).map((s) => ({ slide: s.slide, issues: s.issues })) },
    validation: {},
  };

  const resultDoc = {
    jobId, mode: "vlm", model, backend,
    input: path.basename(input),
    created: t0,
    slides: slides.map((s) => s.failed
      ? { slide: s.slide, failed: true, issues: s.issues ?? [], confidence: "low" }
      : { ...s.json, reviewed: false, failed: false }),
  };
  // Compute the initial queue (auto vs queued/failed) and store it in status.json.
  const initialStatuses = buildStatusSlideMap(resultDoc.slides, hints);
  for (const [n, s] of Object.entries(initialStatuses)) status.slides[n] = s;

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  fs.writeFileSync(resultPath, JSON.stringify(resultDoc, null, 2));
  fs.writeFileSync(reportPath, JSON.stringify({ ...report, timings: recentTimings() }, null, 2));
  fs.writeFileSync(path.join(outDir, "hints.json"), JSON.stringify(hints, null, 2));
  writeStatus({ status: "review", slides: status.slides, issues: status.issues });
  // main.json is the merged deliverable — rebuilt atomically here so a partial read can never observe it revising.
  writeMainAtomic(outDir, mergeSlides(resultDoc, status.slides));

  return { jobId, outDir, result: resultDoc, report, manifest, status, slidesDir };
}
