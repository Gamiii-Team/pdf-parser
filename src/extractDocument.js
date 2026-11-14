// src/extractDocument.js
// Mode-agnostic entry point:
//   extractDocument(input, { mode, ...options }) -> { manifestPath, reportPath, manifest, report }
//
// Pipeline: input → per-mode element extraction → stitch → chunk → validate
//           (Ajv + completeness check) → manifest.json + run report.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { config, missingConfigForMode, configHintForMode, PROMPT_VERSION } from "./config.js";
import { detectInputKind, renderPdfPages, renderPage, getPdfInfo } from "./render.js";
import { extractTextItems } from "unpdf";
import { createLogger } from "./util/log.js";
import { mapWithConcurrency } from "./util/concurrency.js";
import { FileCache } from "./util/cache.js";
import { estimateTokens } from "./util/token.js";
import { stitchElements } from "./stitch.js";
import { chunkDocument, CompletenessError } from "./chunker.js";
import { validateManifest } from "./schema.js";
import { extractPageElements } from "./modes/pageImage.js";
import { extractHybridFlorence } from "./modes/hybridFlorence.js";
import { extractFullFlorence } from "./modes/fullFlorence.js";
import { makeGroqAdapter } from "./providers/groq.js";
import { makeModalVllmAdapter } from "./providers/modalVllm.js";
import { makeModalVllmQwen8bAdapter } from "./providers/modalVllmQwen8b.js";
import { makeModalVllmQwen27bAdapter } from "./providers/modalVllmQwen27b.js";

const VALID_MODES = new Set([
  "hybrid-florence",
  "full-florence",
  "full-groq",
  "full-modal",
  "full-qwen-8b",
  "full-qwen-27b",
]);

/** Per-page text-layer hint (born-digital PDFs only; scans return null). */
async function pageTextHints(pdfPath) {
  try {
    const buf = new Uint8Array(fs.readFileSync(pdfPath));
    const { items } = await extractTextItems(buf);
    return items.map((pageItems) => {
      const text = (pageItems ?? [])
        .map((it) => it.str ?? "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      return text.length >= 30 ? text : null;
    });
  } catch {
    return [];
  }
}

function summarizeElements(elements) {
  const byType = {};
  for (const el of elements) byType[el.type] = (byType[el.type] ?? 0) + 1;
  return byType;
}

function buildManifestDocument({ sourceFile, pages, mode, model, dpi, warnings }) {
  return {
    source_file: path.resolve(sourceFile),
    pages,
    mode,
    model,
    schema_version: "1",
    created_at: new Date().toISOString(),
    dpi,
    prompt_version: PROMPT_VERSION,
    toc: [],
    warnings: warnings.length ? warnings : undefined,
  };
}

export async function extractDocument(input, options = {}) {
  const mode = options.mode ?? "full-groq";
  if (!VALID_MODES.has(mode)) {
    throw new Error(`Unknown mode: ${mode} (expected one of ${[...VALID_MODES].join(", ")})`);
  }
  const missing = missingConfigForMode(mode);
  if (missing.length) {
    throw new Error(`Missing configuration for mode ${mode}: ${missing.join(", ")}.\n${configHintForMode(mode)}`);
  }

  const inputPath = path.resolve(input);
  if (!fs.existsSync(inputPath)) throw new Error(`Input not found: ${inputPath}`);
  const inputKind = detectInputKind(inputPath);
  const logger = options.logger ?? createLogger();
  const dpi = options.dpi ?? config.dpi;
  const cache = new FileCache(config.cacheDir);
  const chunkOpts = {
    targetTokens: options.chunkTargetTokens ?? config.chunkTargetTokens,
    maxTokens: options.chunkMaxTokens ?? config.chunkMaxTokens,
    minTokens: options.chunkMinTokens ?? config.chunkMinTokens,
    overlapTokens: options.chunkOverlapTokens ?? config.chunkOverlapTokens,
  };

  const t0 = Date.now();
  const pageReport = [];
  const warnings = [];
  let elements = [];
  let pageCount = 1;
  let modelName =
    mode === "hybrid-florence" || mode === "full-florence"
      ? (config.florence.visionModel || "florence-2-large")
      : mode === "full-groq"
        ? config.groq.model
        : mode === "full-qwen-8b"
          ? config.modalQwen8b.model
          : mode === "full-qwen-27b"
            ? config.modalQwen27b.model
            : config.modal.model;

  if (mode === "full-florence") {
    // ---------- Mode A': full-florence — Florence text (OCR) + Florence figures ----------
    if (inputKind !== "pdf") {
      throw new Error("full-florence requires a PDF (it runs OCR on rendered page images — use full-groq or full-modal for raw images).");
    }
    const result = await extractFullFlorence({
      inputPath,
      dpi,
      figureAnalyzer: options.figureAnalyzer ?? "florence",
      figurePass: Boolean(options.figurePass),
      logger,
      cache,
    });
    elements = result.elements;
    warnings.push(...result.warnings);
    pageCount = result.pageCount;
    logger?.info?.(`extracted ${elements.length} element(s) across ${pageCount} page(s)`);
  } else if (mode === "hybrid-florence") {
    // ---------- Mode A: hybrid-florence ----------
    if (inputKind !== "pdf") {
      throw new Error("hybrid-florence requires a born-digital PDF with a text layer (use full-groq or full-modal for scans/images).");
    }
    // The Florence-PDF path is for PDFs with a usable text layer — fail fast with guidance otherwise.
    try {
      const probeBuf = new Uint8Array(fs.readFileSync(inputPath));
      const probe = await extractTextItems(probeBuf);
      const visibleChars = (probe.items ?? [])
        .flat()
        .reduce((sum, it) => sum + (it?.str?.trim?.().length ?? 0), 0);
      if (visibleChars < 30) {
        throw new Error(`${mode} found no usable text layer (looks scanned). Use --mode full-groq (or full-modal / full-qwen-*) instead.`);
      }
    } catch (err) {
      if (/florence/.test(err.message)) throw err;
      // unpdf probe failures are treated as 'no text layer'
      throw new Error(`${mode} could not read the text layer: ${err.message}. Use --mode full-groq instead.`);
    }
    const result = await extractHybridFlorence({
      inputPath,
      dpi,
      figureAnalyzer: options.figureAnalyzer ?? "florence",
      figurePass: Boolean(options.figurePass),
      logger,
      cache,
    });
    elements = result.elements;
    warnings.push(...result.warnings);
    pageCount = result.pageCount;
    logger?.info?.(`extracted ${elements.length} element(s) across ${pageCount} page(s)`);
  } else {
    // ---------- Modes 2 & 3: page-as-image through a provider adapter ----------
    const provider =
      mode === "full-groq" ? makeGroqAdapter()
        : mode === "full-qwen-8b" ? makeModalVllmQwen8bAdapter()
          : mode === "full-qwen-27b" ? makeModalVllmQwen27bAdapter()
            : makeModalVllmAdapter();
    modelName = provider.model;

    let pagesToProcess = [];
    let hintList = [];
    if (inputKind === "pdf") {
      logger?.info?.(`rendering PDF at ${dpi} DPI…`);
      const renderResult = await renderPdfPages(inputPath, { dpi });
      pageCount = renderResult.info.pages;
      pagesToProcess = renderResult.pages.map((p) => ({ page: p.page, jpeg: p.jpeg, pageDpi: p.dpi, overflow: p.overflow }));
      hintList = await pageTextHints(inputPath);
      logger?.info?.(`rendered ${pageCount} page(s)`);
    } else if (inputKind === "image") {
      pageCount = 1;
      const buf = fs.readFileSync(inputPath);
      const lower = inputPath.toLowerCase();
      const mime = lower.endsWith(".png") ? "image/png" : lower.endsWith(".webp") ? "image/webp" : lower.endsWith(".gif") ? "image/gif" : "image/jpeg";
      pagesToProcess = [{ page: 1, jpeg: buf, mime, pageDpi: null, overflow: false }];
      hintList = [null];
    } else {
      throw new Error(`Unsupported input type for mode ${mode}: ${inputPath} (expected PDF or png/jpg/webp image)`);
    }

    logger?.info?.(`extracting pages via ${provider.name} (${provider.model}), concurrency=${config.concurrency}`);
    const results = await mapWithConcurrency(pagesToProcess, config.concurrency, async ({ page, jpeg, pageDpi, overflow, mime }) => {
      const hint = hintList[page - 1] ?? null;
      try {
        const r = await extractPageElements({
          provider,
          page,
          jpeg,
          hintText: hint,
          mode,
          cache,
          logger,
          pdfPath: inputKind === "pdf" ? inputPath : null,
          dpi,
          mimeType: mime ?? "image/jpeg",
        });
        if (overflow) {
          warnings.push(`page ${page}: rendered image exceeds provider size guidance; sent anyway (check provider limits)`);
        }
        return { page, jpeg, ...r, error: r.finishReason === "failed" ? (r.elements[0]?.error ?? "unknown") : undefined };
      } catch (err) {
        logger?.error?.(`page ${page} failed: ${err.message}`);
        return {
          page,
          jpeg,
          elements: [{
            id: null, type: "paragraph", page, bbox: [0, 0, 1, 1],
            text: "", source: mode === "full-groq" ? "groq" : "qwen-vl",
            needs_review: true, error: `page_error: ${String(err.message).slice(0, 300)}`,
          }],
          usage: { input: 0, output: 0 },
          finishReason: "failed",
          retries: 0,
          cacheHit: false,
          ms: 0,
          error: String(err.message).slice(0, 300),
        };
      }
    });

    for (const r of results) {
      pageReport.push({
        page: r.page,
        ms: r.ms,
        cache_hit: Boolean(r.cacheHit),
        retries: r.retries ?? 0,
        finish_reason: r.finishReason ?? "unknown",
        truncated: Boolean(r.truncated),
        halved: Boolean(r.halved),
        tokens_in: r.usage?.input ?? 0,
        tokens_out: r.usage?.output ?? 0,
        error: r.error,
      });
      elements.push(...r.elements);
    }

    const failures = results.filter((r) => r.finishReason === "failed");
    if (failures.length) {
      warnings.push(`${failures.length}/${results.length} page(s) failed and were kept as needs_review placeholder elements`);
    }
  }

  // ---------- Stitch → chunk → validate ----------
  const stitched = stitchElements(elements, { maxTokens: chunkOpts.maxTokens });
  const { chunks, toc, stats } = (() => {
    try {
      return chunkDocument(stitched, chunkOpts);
    } catch (err) {
      if (err instanceof CompletenessError) {
        err.message = `Manifest completeness violation: ${err.report.missing.length} element(s) missing from chunks `
          + `(${err.report.missing.slice(0, 10).join(", ")}${err.report.missing.length > 10 ? "…" : ""}), `
          + `${err.report.duplicated.length} duplicated. The run report was still written.`;
        try {
          fs.mkdirSync(config.outDir, { recursive: true });
          fs.writeFileSync(path.join(config.outDir, "completeness-error.json"), JSON.stringify(err.report, null, 2));
        } catch { /* best effort */ }
      }
      throw err;
    }
  })();

  const manifest = {
    document: buildManifestDocument({
      sourceFile: inputPath,
      pages: pageCount,
      mode,
      model: modelName,
      dpi,
      warnings,
    }),
    chunks,
  };
  manifest.document.toc = toc;

  // Ajv validation of the final manifest (fail loudly, write nothing on failure)
  const { ok, errors } = validateManifest(manifest);
  if (!ok) {
    throw new Error(`Manifest failed schema validation: ${errors}`);
  }

  // ---------- Write outputs ----------
  const outBase = options.out
    ? path.resolve(options.out)
    : path.join(config.outDir, path.basename(inputPath, path.extname(inputPath)), mode, "manifest.json");
  fs.mkdirSync(path.dirname(outBase), { recursive: true });
  fs.writeFileSync(outBase, JSON.stringify(manifest, null, 2));

  const tokensIn = pageReport.reduce((s, p) => s + p.tokens_in, 0);
  const tokensOut = pageReport.reduce((s, p) => s + p.tokens_out, 0);
  const estCost = (tokensIn / 1e6) * config.pricePerMInputToken + (tokensOut / 1e6) * config.pricePerMOutputToken;
  const elementSummary = summarizeElements(stitched);

  const report = {
    source_file: path.resolve(inputPath),
    mode,
    model: modelName,
    dpi,
    prompt_version: PROMPT_VERSION,
    input_kind: inputKind,
    pages: pageCount,
    elements: elementSummary,
    elements_total: stitched.length,
    chunk_stats: {
      chunks: stats.chunks,
      oversized_chunks: stats.oversized_chunks,
      needs_review_chunks: stats.needs_review_chunks,
      completeness: stats.completeness,
    },
    toc_entries: toc.length,
    warnings,
    pages_detail: pageReport,
    totals: {
      ms: Date.now() - t0,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      est_cost_usd: Number(estCost.toFixed(6)),
      cache_hits: pageReport.filter((p) => p.cache_hit).length,
      retries: pageReport.reduce((s, p) => s + p.retries, 0),
    },
    outputs: {
      manifest: outBase,
      report: path.join(path.dirname(outBase), "run-report.json"),
    },
  };
  fs.writeFileSync(report.outputs.report, JSON.stringify(report, null, 2));

  return { manifestPath: outBase, reportPath: report.outputs.report, manifest, report };
}
