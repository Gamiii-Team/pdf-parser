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

const DEFAULT_MODELS = {
  groq: "qwen/qwen3.8-27b",
  modal: "Qwen/Qwen3-VL-8B-Instruct-FP8",
};

export async function extractDocument(input, options = {}) {
  const missing = missingFor({ modelBackend: options.modelBackend ?? options.model ?? config.modelBackend });
  if (missing.length) {
    throw new Error(`Missing configuration for ${options.modelBackend ?? config.modelBackend}: ${missing.join(", ")}`);
  }

  const logger = options.logger ?? createLogger();
  const provider = (options.modelBackend ?? options.model ?? config.modelBackend) && (options.modelBackend ?? options.model ?? config.modelBackend) !== "none"
    ? makeProvider(options.modelBackend ?? options.model ?? config.modelBackend)
    : null;

  const t0 = Date.now();
  const { pdfPath, analysis, cleanupPath } = await normalizeInput(input);
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
  const vlmPages = pages.filter((p) => p.route === "vlm");
  if (vlmPages.length) {
    const { blocks: vlmBlocks, usage: vlmUsage, errors: vlmErrors } = await extractVlmPages({ pdfPath, vlmPages, provider, logger });
    tokens.input += vlmUsage.input; tokens.output += vlmUsage.output;
    for (const err of vlmErrors) logger?.warn?.(err);
    for (const b of vlmBlocks) textBlocks.push(b);
  } else {
    logger?.info?.("no VLM-routed pages");
  }

  // Figure-candidate blocks: figure-image & figure-vector
  figureBlocks = textBlocks.filter((b) => b.type === "figure-image" || b.type === "figure-vector");

  // ---------- 2) (Optional) figure analysis pass ----------
  if (options.figurePass !== false && provider && figureBlocks.length > 0) {
    const { figures: enriched, usage } = await analyzeFigures(figureBlocks, { pdfPath, provider, logger, maxDim: options.maxDim });
    tokens.input += usage.input; tokens.output += usage.output;
    // Replace un-enriched figure blocks inline
    for (const e of enriched) {
      const idx = textBlocks.findIndex((b) => b.page === e.page && b.bbox && b.bbox[0] === e.bbox[0] && b.bbox[1] === e.bbox[1]);
      if (idx !== -1) textBlocks[idx] = e;
    }
  }

  // ---------- 3) Tree build ----------
  const flatForTree = textBlocks.map((b) => {
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
  const outDir = path.resolve(options.out ?? path.join(config.outputDir, path.basename(input, path.extname(input))));
  fs.mkdirSync(outDir, { recursive: true });
  const manifestPath = path.join(outDir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const tokensIn = tokens.input;
  const tokensOut = tokens.output;

  const report = {
    source_file: path.resolve(input),
    duration_ms: Date.now() - t0,
    pages: manifest.pages,
    blocks: textBlocks.length,
    sections: countSections(manifest.sections),
    figure_blocks: figureBlocks.length,
    total_tokens_input: tokensIn,
    total_tokens_output: tokensOut,
    validation: {
      text_coverage: textCoverage,
      chart_issues: chartIssues,
      table_issues: tableIssues,
    },
  };
  fs.writeFileSync(path.join(outDir, "run-report.json"), JSON.stringify(report, null, 2));

  return { manifest, manifestPath, outDir, report };
}

function countSections(sections) {
  // Total number of sections (including subsections), for reporting
  let n = 0;
  for (const s of sections ?? []) {
    n += 1 + countSections(s.subsections ?? []);
  }
  return n;
}
