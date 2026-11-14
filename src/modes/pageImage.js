// src/modes/pageImage.js
// Shared implementation for full-modal and full-groq: page -> VLM -> elements.
// The two modes differ ONLY in the provider adapter injected by the caller.

import { buildPagePrompt } from "../prompts/index.js";
import { toDataUrl, renderPageHalves } from "../render.js";
import { validateRawPageResponse } from "../schema.js";
import { normalizeUnitBBox, tableToMarkdown } from "../elements.js";
import { estimateTokens } from "../util/token.js";
import { sha256Buffer } from "../util/hash.js";
import { PROMPT_VERSION, config } from "../config.js";

function sourceFor(providerName) {
  return providerName === "groq" ? "groq" : "qwen-vl";
}

/** Extract the first balanced JSON object from a model response. */
function parseModelJson(text) {
  if (!text || !text.trim()) throw new Error("empty response");
  let cleaned = String(text).replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) cleaned = fence[1].trim();
  const start = cleaned.indexOf("{");
  if (start === -1) throw new Error("no JSON object found in response");
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(cleaned.slice(start, i + 1));
    }
  }
  throw new Error("unbalanced JSON in response");
}

const FIGURE_TYPES = new Set([
  "bar_chart", "line_chart", "scatter", "pie_chart", "flowchart",
  "uml", "schematic", "photo", "screenshot", "table_image", "other",
]);

function normalizeTableRows(rawRows) {
  if (!Array.isArray(rawRows)) return null;
  const rows = rawRows
    .map((row) => (Array.isArray(row) ? row.map((cell) => String(cell ?? "")) : null))
    .filter(Boolean);
  return rows.length ? rows : null;
}

/** Normalize a model-returned element into the canonical element shape. */
export function normalizeRawElement(raw, { page, source }) {
  const needsReview = (flag) => Boolean(flag);
  const bbox = normalizeUnitBBox(raw.bbox) ?? [0, 0, 1, 1];
  const bboxMissing = !normalizeUnitBBox(raw.bbox);
  const type = raw.type;
  const text = typeof raw.text === "string" ? raw.text : (typeof raw.formula === "string" ? raw.formula : "");

  const base = {
    id: null,
    type,
    page,
    bbox,
    source,
    needs_review: needsReview(raw.needs_review) || bboxMissing,
  };
  if (bboxMissing) base.needs_review = true;

  switch (type) {
    case "heading":
      return { ...base, text, level: Number.isInteger(raw.level) ? Math.min(Math.max(raw.level, 1), 6) : 2 };
    case "table": {
      const rows = normalizeTableRows(raw.rows);
      const header_rows = Number.isInteger(raw.header_rows) ? Math.max(0, raw.header_rows) : rows ? 1 : 0;
      const fixed = rows ?? [[""]];
      return { ...base, text: undefined, rows: fixed, header_rows, caption: raw.caption ?? null,
               needs_review: base.needs_review || !rows };
    }
    case "figure": {
      const figureType = FIGURE_TYPES.has(raw.figure_type) ? raw.figure_type
        : FIGURE_TYPES.has(String(raw.figure_type ?? "").toLowerCase()) ? String(raw.figure_type).toLowerCase()
        : "other";
      return { ...base, figure_type: figureType, description: String(raw.description ?? ""),
               caption: raw.caption ?? null, data: raw.data && typeof raw.data === "object" ? raw.data : null,
               text: undefined };
    }
    case "caption":
      return { ...base, text };
    case "list":
      return { ...base, text };
    case "code":
      return { ...base, text };
    case "equation":
      return { ...base, text };
    case "paragraph":
    default:
      return { ...base, type: "paragraph", text };
  }
}

async function callAndParse({ provider, messages, maxTokens, logger, tag }) {
  const { text, finishReason, usage } = await provider.complete(messages, { maxTokens, temperature: 0.1 });
  const parsed = parseModelJson(text);
  const { ok, errors } = validateRawPageResponse(parsed);
  if (!ok) throw new Error(`schema validation failed: ${errors}`);
  logger?.debug?.(`${tag}: finish=${finishReason} in=${usage.input} out=${usage.output} tok-est elements=${estimateTokens(text)}`);
  return { parsed, finishReason, usage, raw: text };
}

/**
 * @param {{provider, page, jpeg, hintText?, mode, cache, logger, pdfPath?, dpi?}} args
 */
export async function extractPageElements({ provider, page, jpeg, hintText = null, mode, cache, logger, pdfPath = null, dpi = config.dpi, mimeType = "image/jpeg" }) {
  const t0 = Date.now();
  const source = sourceFor(provider.name);
  const dataUrl = toDataUrl(jpeg, mimeType);
  const imgHash = sha256Buffer(jpeg);
  const cacheParts = [imgHash, mode, provider.model, PROMPT_VERSION, hintText ? "hint" : "nohint", String(dpi), mimeType];

  if (cache) {
    const cached = cache.get(cacheParts);
    if (cached) {
      return { ...cached, cacheHit: true, ms: Date.now() - t0, page };
    }
  }

  const basePrompt = buildPagePrompt({ hintText });
  const messages = [{
    role: "user",
    content: [
      { type: "text", text: basePrompt },
      { type: "image_url", image_url: { url: dataUrl } },
    ],
  }];

  let prompt = basePrompt;
  let attempts = 0;
  let lastError = null;
  let lastRaw = "";
  const maxTokensPerPage = 8192;

  for (;;) {
    attempts += 1;
    const msgs = [{ ...messages[0], content: [{ type: "text", text: prompt }, messages[0].content[1]] }];
    try {
      const { parsed, finishReason, usage, raw } = await callAndParse({ provider, messages: msgs, maxTokens: maxTokensPerPage, logger, tag: `page ${page} attempt ${attempts}` });
      lastRaw = raw;
      const elements = (parsed.elements ?? []).map((rawEl) => normalizeRawElement(rawEl, { page, source }));
      const result = {
        elements,
        usage,
        finishReason,
        raw: raw,
        retries: attempts - 1,
        truncated: finishReason === "length",
      };
      if (cache) cache.set(cacheParts, result);
      return { ...result, cacheHit: false, ms: Date.now() - t0, page };
    } catch (err) {
      lastError = err;
      logger?.warn?.(`page ${page} attempt ${attempts} failed: ${err.message}`);
      if (attempts > config.retries) break; // 1 initial attempt + `retries` retries
      prompt = `${basePrompt}\n\n=== PREVIOUS ATTEMPT FAILED ===\n${String(err.message).slice(0, 800)}\nFix the issues above and return corrected JSON for the whole page.`;
    }
  }

  // --- Dense-page fallback: split into top/bottom halves (PDF only) ---
  if (pdfPath) {
    try {
      logger?.warn?.(`page ${page}: falling back to dense-page halving`);
      const { halves, pageHeightPx } = await renderPageHalves(pdfPath, page, { dpi });
      const merged = [];
      let totalUsage = { input: 0, output: 0 };
      let anySuccess = false;
      for (const half of halves) {
        const halfDataUrl = toDataUrl(half.jpeg, "image/jpeg");
        let ok = null;
        for (let halfAttempt = 0; halfAttempt < 2 && !ok; halfAttempt += 1) {
          try {
            const msgs = [{
              role: "user",
              content: [
                { type: "text", text: basePrompt },
                { type: "image_url", image_url: { url: halfDataUrl } },
              ],
            }];
            const { parsed, finishReason, usage, raw } = await callAndParse({ provider, messages: msgs, maxTokens: 8192, logger, tag: `page ${page} ${half.half} attempt ${halfAttempt + 1}` });
            ok = { parsed, finishReason, usage, raw };
          } catch (err) {
            logger?.warn?.(`page ${page} ${half.half} attempt ${halfAttempt + 1} failed: ${err.message}`);
          }
        }
        if (ok) {
          anySuccess = true;
          totalUsage = { input: totalUsage.input + ok.usage.input, output: totalUsage.output + ok.usage.output };
          for (const rawEl of ok.parsed.elements ?? []) {
            const el = normalizeRawElement(rawEl, { page, source });
            let [x0, y0, x1, y1] = el.bbox;
            if (half.half === "top") {
              el.bbox = [x0, y0 * half.fraction, x1, y1 * half.fraction];
            } else {
              const yOffsetFraction = half.yOffsetPx / pageHeightPx;
              el.bbox = [x0, Math.min(1, yOffsetFraction + y0 * half.fraction), x1, Math.min(1, yOffsetFraction + y1 * half.fraction)];
            }
            merged.push(el);
          }
        }
      }
      if (anySuccess) {
        const deduped = dedupeOverlay(merged);
        const result = {
          elements: deduped,
          usage: totalUsage,
          finishReason: "length",
          raw: "",
          retries: attempts - 1,
          truncated: true,
          halved: true,
        };
        if (cache) cache.set(cacheParts, result);
        return { ...result, cacheHit: false, ms: Date.now() - t0, page };
      }
    } catch (halfErr) {
      logger?.error?.(`page ${page}: halving failed: ${halfErr.message}`);
    }
  }

  // --- Final fallback: keep raw text, flag the page, never drop it ---
  logger?.error?.(`page ${page}: extraction failed after ${attempts} attempt(s): ${lastError?.message}`);
  return {
    elements: [{
      id: null,
      type: "paragraph",
      page,
      bbox: [0, 0, 1, 1],
      text: "",
      source,
      needs_review: true,
      error: `extraction_failed: ${String(lastError?.message ?? lastError).slice(0, 300)}`,
    }],
    usage: { input: 0, output: 0 },
    finishReason: "failed",
    raw: lastRaw,
    retries: attempts - 1,
    ms: Date.now() - t0,
    page,
  };
}

/** Drop duplicated elements across the half seam; merge split tables. */
function dedupeOverlay(elements) {
  const out = [];
  const tableByHeader = new Map();
  const seen = new Set();
  for (const el of elements) {
    if (el.type === "table") {
      const headerKey = (el.rows?.[0] ?? []).map((c) => String(c).trim().toLowerCase()).join("|");
      const colCount = Math.max(0, ...(el.rows ?? []).map((r) => r.length));
      const key = `${headerKey}::${colCount}`;
      const existing = tableByHeader.get(key);
      if (existing) {
        // Same table seen on both sides of the seam: append new rows only.
        const seenRows = new Set(existing.rows.map((r) => r.join("")));
        const extra = (el.rows ?? []).slice(1).filter((r) => !seenRows.has(r.join("")));
        if (extra.length) {
          existing.rows = [...existing.rows, ...extra];
          existing.text = tableToMarkdown(existing.rows, existing.header_rows ?? 1);
        }
        continue;
      }
      tableByHeader.set(key, el);
      out.push(el);
      continue;
    }
    const key = `${el.type}|${String(el.text ?? el.caption ?? "").slice(0, 80).toLowerCase().replace(/\s+/g, " ")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(el);
  }
  return out;
}
