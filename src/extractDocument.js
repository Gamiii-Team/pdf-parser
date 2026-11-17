// src/extractDocument.js
// Main entry: file → manifest.json + run-report.json
//
// Pipeline:
//   normalizeInput (PDF or image→PDF) → analyzePdf (PyMuPDF)
//   → routePages (text-layer vs VLM) → extract text blocks
//   → (optional) VLM enrichment for figure blocks
//   → buildTree → manifest assembly → validation → write

import fs from "node:fs";
import path from "node:path";

import { analyzePdf, spawnWorker, cropRegion, renderPage } from "./pymupdf/run.js";
import { config, missingFor } from "./config.js";
import { normalizeInput } from "./input/normalize.js";
import { routePages } from "./input/router.js";
import { extractTextPage } from "./extract/textPage.js";
import { buildTree } from "./extract/treeBuilder.js";
import { analyzeFigures } from "./extract/figures.js";
import { extractVlmPages } from "./extract/vlmPage.js";
import { makeProvider } from "./providers/index.js";
import { createLogger } from "./util/log.js";
import { resolveSubject } from "./extract/subject.js";
import { validateTextCoverage, validateCharts, validateTables } from "./validate/index.js";
import { genRunId, formatRunFolder } from "./util/runName.js";

const DEFAULT_MODELS = {
  groq: "qwen/qwen3.8-27b",
  modal: "Qwen/Qwen3-VL-8B-Instruct-FP8",
};

/**
 * Cross-path dedup: the text-layer and VLM paths both transcribe the same
 * heading/caption on a page, producing duplicate sections and blocks.
 * Merge identical (page, type, normalized-text) blocks from different paths:
 * keep the first (span-derived wins because it carries a bbox), OR their flags.
 */
const DEDUPE_TYPES = new Set(["heading", "text", "notes", "list"]);

export function dedupeCrossPathBlocks(blocks) {
  const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  const keyFor = (b) => `${b.page}|${b.type}|${norm(b.content ?? (Array.isArray(b.items) ? b.items.join("|") : ""))}`;
  const seen = new Map();
  const out = [];
  let dropped = 0;
  for (const b of blocks) {
    const text = norm(b.content ?? (Array.isArray(b.items) ? b.items.join(" ") : ""));
    if (!DEDUPE_TYPES.has(b.type) || !text) { out.push(b); continue; }
    const key = keyFor(b);
    const first = seen.get(key);
    if (first) {
      first.needs_review = Boolean(first.needs_review) || Boolean(b.needs_review);
      if (!first.bbox && b.bbox) first.bbox = b.bbox;
      if (!first.caption && b.caption) first.caption = b.caption;
      dropped += 1;
      continue;
    }
    seen.set(key, b);
    out.push(b);
  }
  return { blocks: out, dropped };
}

export async function extractDocument(input, options = {}) {
  const backend = options.modelBackend ?? options.model ?? config.modelBackend;
  const model = backend === "groq" ? config.groqModel : backend === "modal" ? config.modalModel : "";
  const runId = options.runId ?? genRunId();

  // Test hook: options.provider injects a pre-built provider (e.g. a stub in tests),
  // skipping env-based construction and the missing-config check.
  const missing = options.provider ? [] : missingFor({ modelBackend: backend });
  if (missing.length) {
    throw new Error(`Missing configuration for ${backend}: ${missing.join(", ")}`);
  }

  const logger = options.logger ?? createLogger();
  const provider = options.provider ?? (backend && backend !== "none" ? makeProvider(backend) : null);

  const t0 = Date.now();
  const { pdfPath, analysis, cleanupPath, pptx } = await normalizeInput(input, { logger, onStage: options.onStage });
  const routed = await routePages(analysis, { forceVlm: Boolean(options.forceVlm) });
  logger?.info?.(`analyzed ${analysis.num_pages} page(s); routes: ${routed.map((p) => `p${p.page}=${p.route}`).join(", ")}`);

  // ---------- 1) Text-layer extractor for text pages ----------
  const textBlocks = [];
  let figureBlocks = [];
  const pages = (analysis.pages ?? []).map((p) => ({ ...p, route: routed.find((r) => r.page === p.page)?.route }));

  // Export the text-layer pages to the PyMuPDF worker one last time to get block text encoded cleanly.
  // The worker already returns everything; we just need per-page line/text data.
  const { bodySize, blocks } = extractTextPage(pages);
  for (const b of blocks) textBlocks.push(b);

  // ---------- 1b) VLM page path for routed pages ----------
  const tokens = { input: 0, output: 0 };
  const analysisErrors = { vlm_page: [], figure_pass: [], subject: [] };
  const vlmPages = pages.filter((p) => p.route === "vlm");
  if (vlmPages.length) {
    const { blocks: vlmBlocks, usage: vlmUsage, errors: vlmErrors } = await extractVlmPages({ pdfPath, vlmPages, provider, logger });
    tokens.input += vlmUsage.input; tokens.output += vlmUsage.output;
    for (const err of vlmErrors) logger?.warn?.(err);
    analysisErrors.vlm_page.push(...vlmErrors);
    for (const b of vlmBlocks) textBlocks.push(b);
  } else {
    logger?.info?.("no VLM-routed pages");
  }

  // ---------- 1c) Flagged chart blocks from the VLM path get the figure pass too ----------
  // VLM-routed pages emit type "chart" blocks directly (bbox: null) and would
  // otherwise bypass the figure analyzer entirely — which is how chart data
  // ends up as needs_review/null in the manifest. Run the same analysis on the
  // offending blocks: crop the page's sole embedded image when there is one,
  // otherwise the whole page.
  const flaggedIdx = [];
  for (let i = 0; i < textBlocks.length; i++) {
    const b = textBlocks[i];
    if (b.type === "chart" && (b.content == null || b.needs_review === true)) flaggedIdx.push(i);
  }
  let flaggedEnriched = 0;
  if (options.figurePass !== false && provider && flaggedIdx.length > 0) {
    const pagesByNum = new Map((analysis.pages ?? []).map((p) => [p.page, p]));
    const candidates = flaggedIdx.map((i) => {
      const b = textBlocks[i];
      const pa = pagesByNum.get(b.page);
      const imgs = pa?.images ?? [];
      const bbox = b.bbox ?? (imgs.length === 1 ? imgs[0].bbox : [0, 0, pa?.width ?? 612, pa?.height ?? 792]);
      return { ...b, bbox, caption: b.caption ?? null };
    });
    const { figures: enrichedFlagged, usage, errors: figureErrors } = await analyzeFigures(candidates, { pdfPath, provider, logger, maxDim: options.maxDim });
    tokens.input += usage.input; tokens.output += usage.output;
    analysisErrors.figure_pass.push(...figureErrors);
    flaggedEnriched = flaggedIdx.length;
    for (let j = 0; j < flaggedIdx.length; j++) {
      const e = enrichedFlagged[j];
      textBlocks[flaggedIdx[j]] = {
        ...textBlocks[flaggedIdx[j]],
        chart_type: e.chart_type,
        title: e.title,
        description: e.description,
        content: e.content,
        estimates: e.estimates,
        needs_review: e.needs_review ?? false,
        notes: e.notes,
      };
    }
  }

  // Figure-candidate blocks: figure-image & figure-vector
  figureBlocks = textBlocks.filter((b) => b.type === "figure-image" || b.type === "figure-vector");

  // ---------- 2) (Optional) figure analysis pass ----------
  if (options.figurePass !== false && provider && figureBlocks.length > 0) {
    const { figures: enriched, usage, errors: mainFigureErrors } = await analyzeFigures(figureBlocks, { pdfPath, provider, logger, maxDim: options.maxDim });
    tokens.input += usage.input; tokens.output += usage.output;
    analysisErrors.figure_pass.push(...mainFigureErrors ?? []);
    // Replace un-enriched figure blocks inline
    for (const e of enriched) {
      const idx = textBlocks.findIndex((b) => b.page === e.page && b.bbox && b.bbox[0] === e.bbox[0] && b.bbox[1] === e.bbox[1]);
      if (idx !== -1) textBlocks[idx] = e;
    }
  }

  // ---------- 3) Cross-path dedup + tree build ----------
  const { blocks: dedupedBlocks, dropped: dedupedCount } = dedupeCrossPathBlocks(textBlocks);
  const flatForTree = dedupedBlocks.map((b) => {
    const base = { page: b.page, bbox: b.bbox, caption: b.caption ?? null, needs_review: b.needs_review ?? false };
    if (b.type === "heading") return { ...base, type: "heading", level: b.level ?? 1, content: b.content };
    if (b.type === "table") return { ...base, type: "table", header_rows: b.header_rows ?? 0, content: b.content };
    if (b.type === "list") return { ...base, type: "list", items: b.items ?? [] };
    if (b.type === "figure-image" || b.type === "figure-vector") {
      return { ...base, type: "chart", chart_type: b.chart_type ?? "other", title: b.title ?? null, description: b.description ?? null, content: b.content ?? null, estimates: b.estimates === true };
    }
    if (b.type === "image") return { ...base, type: "image" };
    if (b.type === "chart") return { ...base, type: "chart", chart_type: b.chart_type ?? "other", title: b.title ?? null, description: b.description ?? null, content: b.content ?? null, estimates: b.estimates === true };
    if (b.type === "notes") return { ...base, type: "notes", content: b.content };
    if (b.type === "caption") return { ...base, type: "text", content: b.content }; // unattached captions: keep visible as text
    return { ...base, type: "text", content: b.content };
  });
  const sections = buildTree(flatForTree, { fallbackHeading: "Document" });

  // ---------- 4) Subject + validation ----------
  // Subject detection: only when a provider exists (text-only/offline runs get "unknown").
  const subjectInfo = options.subjectDetect === false
    ? (options.subject?.trim()
        ? { subject: options.subject.trim(), subject_source: "user" }
        : { subject: "unknown", subject_source: "unavailable" })
    : await resolveSubject(options.subject, { blocks: flatForTree, provider, logger });
  if (subjectInfo.usage) { tokens.input += subjectInfo.usage.input; tokens.output += subjectInfo.usage.output; }
  if (subjectInfo.error) analysisErrors.subject.push(subjectInfo.error);

  const textCoverage = validateTextCoverage({ routedPages: pages, textBlocks });
  const chartIssues = validateCharts(sections);
  const tableIssues = validateTables(sections);

  // ---------- 5) Manifest assembly ----------
  const manifest = {
    id: `doc_${Date.now().toString(16)}`,
    subject: subjectInfo.subject,
    subject_source: subjectInfo.subject_source,
    source_file: path.resolve(input),
    pages: analysis.num_pages,
    sections,
  };

  // ---------- 6) Write output ----------
  if (cleanupPath) { try { fs.unlinkSync(cleanupPath); } catch {} }
  const outDir = path.resolve(options.out ?? path.join(config.outputDir, "cli", formatRunFolder({
    backend,
    model,
    inputName: path.basename(input),
    runId,
  })));
  fs.mkdirSync(outDir, { recursive: true });
  const manifestPath = path.join(outDir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const tokensIn = tokens.input;
  const tokensOut = tokens.output;

  const report = {
    run_id: runId,
    source_file: path.resolve(input),
    duration_ms: Date.now() - t0,
    pages: manifest.pages,
    blocks: dedupedBlocks.length,
    deduped_blocks: dedupedCount,
    sections: countSections(manifest.sections),
    figure_blocks: figureBlocks.length + flaggedEnriched,
    total_tokens_input: tokensIn,
    total_tokens_output: tokensOut,
    ...(pptx ? { pptx } : {}),
    errors: {
      vlm_page: analysisErrors.vlm_page,
      figure_pass: analysisErrors.figure_pass,
      subject: analysisErrors.subject,
    },
    validation: {
      figures: chartStats(manifest.sections),
      text_coverage: textCoverage,
      chart_issues: chartIssues,
      table_issues: tableIssues,
    },
  };
  fs.writeFileSync(path.join(outDir, "run-report.json"), JSON.stringify(report, null, 2));

  return { manifest, manifestPath, outDir, report, runId };
}

function countSections(sections) {
  // Total number of sections (including subsections), for reporting
  let n = 0;
  for (const s of sections ?? []) {
    n += 1 + countSections(s.subsections ?? []);
  }
  return n;
}

function chartStats(sections) {
  let chart = 0, empty = 0, needsReview = 0, estimated = 0;
  const walk = (list) => {
    for (const s of list ?? []) {
      for (const b of s.content ?? []) {
        if (b.type !== "chart") continue;
        chart += 1;
        if (!b.content) empty += 1;
        if (b.needs_review) needsReview += 1;
        if (b.estimates) estimated += 1;
      }
      walk(s.subsections);
    }
  };
  walk(sections);
  return { chart_blocks: chart, empty_content: empty, needs_review: needsReview, estimated };
}
