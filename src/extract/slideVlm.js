// src/extract/slideVlm.js — full-VLM analysis path (one Groq request per slide).
// Renders each PDF page to PNG, pairs it with the PDF text layer and the native
// hints extracted from the .pptx, then asks the model for structured per-slide JSON.
// Malformed output is retried once; a failed slide does not fail the job.
// Images leave the machine (see README privacy note).

import fs from "node:fs";
import path from "node:path";

import { config } from "../config.js";
import { renderPage } from "../pymupdf/run.js";
import { validateSlide, crossCheckSlide, validateFigures, validateTables } from "../validate/slideSchema.js";
import { logTiming } from "../util/log.js";

const MAX_TEXT_LAYER_CHARS = 4000;

function parseModelJson(text) {
  if (!text) throw new Error("empty response");
  let cleaned = String(text).replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) cleaned = fence[1].trim();
  const start = cleaned.indexOf("{");
  if (start === -1) throw new Error("no JSON object in response");
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
    else if (ch === "}") { depth -= 1; if (depth === 0) return JSON.parse(cleaned.slice(start, i + 1)); }
  }
  throw new Error("unbalanced JSON in response");
}

function pageText(page, maxChars = MAX_TEXT_LAYER_CHARS) {
  const lines = (page?.lines ?? []).map((l) => l?.text ?? "").filter(Boolean);
  const text = lines.join("\n");
  return text.length > maxChars ? text.slice(0, maxChars) + "\n[truncated]" : text;
}

const stripMeta = (hint) => {
  if (!hint || typeof hint !== "object") return null;
  const { hidden, empty, ...rest } = hint;
  return rest;
};

/** Attach native bounding boxes (same kind, reading order) to figures that lack one. */
function attachNativeBoxes(slideJson, hint) {
  if (!hint) return slideJson;
  const figs = slideJson.figures ?? [];
  let ci = 0, pi = 0, gi = 0;
  for (const fig of figs) {
    if (fig.bbox) continue;
    const take = (box) => { if (box) { fig.bbox = box; fig.bbox_source = "native"; return true; } return false; };
    if (fig.type === "chart" && hint.charts?.[ci]) { const ok = take(hint.charts[ci].bbox); ci += 1; if (ok) continue; }
    if (["image", "logo", "icon", "screenshot"].includes(fig.type) && hint.pictures?.[pi]) { const ok = take(hint.pictures[pi].bbox); pi += 1; if (ok) continue; }
    if (["diagram", "image", "screenshot"].includes(fig.type) && hint.groups?.[gi]) { const ok = take(hint.groups[gi].bbox); gi += 1; }
  }
  return slideJson;
}

function slidePromptUser({ n, total, prevTitle, textLayer, nativeHintsJson }) {
  return `Slide number: ${n} of ${total}.
Previous slide title (context only): ${prevTitle ?? "none"}.
Text layer from the rendered PDF (may be out of order):
<text_layer>${textLayer}</text_layer>
Native data extracted from the PPTX file itself (exact; may be empty):
<native>${nativeHintsJson}</native>
Return the JSON for this slide only.`;
}

export async function analyzeSlide({ n, total, prevTitle, pngPath, textLayer, nativeHints, provider, logger }) {
  const prompt = fs.readFileSync(new URL("../prompts/slide.prompt.md", import.meta.url), "utf8");
  const image = fs.readFileSync(pngPath);
  const imageUrl = `data:image/png;base64,${image.toString("base64")}`;
  const user = slidePromptUser({
    n, total, prevTitle, textLayer,
    nativeHintsJson: nativeHints ? JSON.stringify(nativeHints).slice(0, 8000) : "{}",
  });
  const usage = { input: 0, output: 0 };
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const messages = [
        { role: "system", content: prompt },
        { role: "user", content: [
          { type: "text", text: user + (attempt === 1 ? "\n\nReminder: output ONLY the JSON object, no prose, no fences." : "") },
          { type: "image_url", image_url: { url: imageUrl } },
        ] },
      ];
      const tag = "slide";
      const t0 = Date.now();
      const { text, usage: u } = await provider.complete(messages, { maxTokens: 4096, temperature: 0.1 });
      usage.input += u?.input ?? 0; usage.output += u?.output ?? 0;
      logTiming({ phase: "vlm-call", kind: tag, slide: n, attempt: attempt + 1, input_tokens: u?.input ?? 0, output_tokens: u?.output ?? 0, ms: Date.now() - t0 });
      const parsed = parseModelJson(text);
      const { ok, errors } = validateSlide(parsed, { expectedSlide: n });
      if (ok) {
        attachNativeBoxes(parsed, nativeHints);
        const check = crossCheckSlide(parsed, nativeHints);
        return { slide: n, failed: false, json: { ...parsed, confidence: check.confidence, issues: [...(parsed.issues ?? []), ...check.issues] }, usage, retried: attempt > 0 };
      }
      lastError = `schema validation failed: ${errors.slice(0, 6).join("; ")}`;
      logger?.warn?.(`slide ${n}: ${lastError}`);
    } catch (err) {
      lastError = String(err?.message ?? err);
      logger?.warn?.(`slide ${n}: VLM attempt ${attempt + 1} failed: ${lastError}`);
    }
  }
  usage.input += 0; usage.output += 0;
  return { slide: n, failed: true, usage, issues: [`slide analysis failed: ${lastError ?? "unknown error"}`] };
}

export { pageText } // for server-side text-layer reuse

/**
 * Re-run the figure/table analysis for one slide with human-reviewer guidance.
 * Replaces ONLY figures and tables; everything else in the slide JSON is kept by the caller.
 * Returns { figures, tables, usage } on success; throws on failure (caller keeps the old version).
 */
export async function rerunFigures({ pngPath, currentSlide, slideNote = "", figureNotes = [], provider, logger, crops = [] }) {
  const prompt = fs.readFileSync(new URL("../prompts/slide.prompt.md", import.meta.url), "utf8");
  const image = fs.readFileSync(pngPath);
  const imageUrl = `data:image/png;base64,${image.toString("base64")}`;
  const n = currentSlide?.slide ?? null;
  const kept = (currentSlide?.figures ?? []).filter((f) => f.excluded || f.bbox_locked);
  const keptDesc = kept
    .map((f) => `"${String(f.description ?? "").slice(0, 100)}" (${f.excluded ? "not a figure" : "reviewer-locked — never move or resize"}${f.type ? `; ${f.type}` : ""})`)
    .join("; ");
  const figureNotesText = (figureNotes ?? [])
    .map((fn) => `figure ${Number(fn.index) + 1}: ${String(fn.note ?? "").slice(0, 1000)}`)
    .join("\n");
  const cropLines = (crops ?? []).slice(0, 2).map((c, i) => `Also use Image ${i + 2} as the enlarged crop of the region the reviewer boxed as Figure ${c.index + 1}.`);
  const user = [
    `Re-examine this slide's figures and tables only (slide ${n}). Do not change text blocks, title, subtitle or notes.`,
    `Current figures and tables JSON:`,
    `<current>${JSON.stringify({ figures: currentSlide?.figures ?? [], tables: currentSlide?.tables ?? [] })}</current>`,
    `A human reviewer gave this feedback. It is trustworthy information about what is on the slide:`,
    `<reviewer>`,
    `Slide-level note: ${String(slideNote).slice(0, 1000) || "none"}`,
    `Figure notes:`,
    figureNotesText || "none",
    `Items the reviewer marked as NOT figures, or as reviewer-locked (keep them exactly as they are — never move, resize or re-describe them): ${keptDesc || "none"}`,
    `</reviewer>`,
    ...(cropLines.length ? ["Crops:", ...cropLines,
      "Crop instructions: Image 1 is the full slide. Image 2" + (crops.length > 1 ? " and Image 3" : "") + " is/are crops of the region(s) marked as figure(s) by the reviewer, rendered enlarged for readability. Treat everything inside a crop as part of that figure, including parts that look cut off in Image 1. Describe the whole figure: its overall purpose, every labelled box or group, the text inside each, and how items connect (arrows, flow direction, grouping). Put all text you can read into \"visible_text\", in reading order. If some text is too small to read, say so in \"issues\" instead of guessing. Do not describe anything outside the crop except for context."] : []),
    `Look carefully for anything the feedback says is missing or wrong, correct it, keep what is already correct, and return JSON: {"figures": [...], "tables": [...]}.`,
  ].join("\n");
  const usage = { input: 0, output: 0 };
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const messages = [
        { role: "system", content: prompt },
        { role: "user", content: [
          { type: "text", text: user + (attempt === 1 ? "\n\nReminder: output ONLY the JSON object, no prose, no fences." : "") },
          { type: "image_url", image_url: { url: imageUrl } },
          ...(crops ?? []).slice(0, 2).map((c) => ({ type: "image_url", image_url: { url: `data:image/png;base64,${fs.readFileSync(c.path).toString("base64")}` } })),
        ] },
      ];
      const tag = currentSlide ? "rerun" : "slide";
      const t0 = Date.now();
      const { text, usage: u } = await provider.complete(messages, { maxTokens: 4096, temperature: 0.1 });
      usage.input += u?.input ?? 0; usage.output += u?.output ?? 0;
      logTiming({ phase: "vlm-call", kind: tag, slide: n, attempt: attempt + 1, input_tokens: u?.input ?? 0, output_tokens: u?.output ?? 0, ms: Date.now() - t0 });
      const parsed = parseModelJson(text);
      const fig = validateFigures(parsed.figures);
      const tbl = validateTables(parsed.tables);
      if (fig.ok && tbl.ok) {
        return { figures: parsed.figures ?? [], tables: parsed.tables ?? [], usage };
      }
      lastError = `schema validation failed: ${[...fig.errors, ...tbl.errors].slice(0, 6).join("; ")}`;
      logger?.warn?.(`slide ${n} rerun: ${lastError}`);
    } catch (err) {
      lastError = String(err?.message ?? err);
      logger?.warn?.(`slide ${n} rerun attempt ${attempt + 1} failed: ${lastError}`);
    }
  }
  throw new Error(`re-run failed: ${lastError ?? "unknown error"}`);
}

/**
 * Run the full-VLM analysis for every page of pdfPath (one request per slide).
 * @param {{pdfPath: string, pages: object[], hints: object[], provider: object, slidesDir: string,
 *          logger: object, concurrency?: number, dpi?: number, onSlideStatus?: (n:number, status:string)=>void}} opts
 */
export async function extractSlidesVlm(opts) {
  const { pdfPath, pages, hints, provider, slidesDir, logger } = opts;
  const dpi = opts.dpi ?? 150;
  const total = pages.length;
  const usage = { input: 0, output: 0 };
  const slides = new Array(total).fill(null);
  const images = total;
  const jobId = opts.jobId ?? null;
  const cancelRequested = () => Boolean(opts.cancelRequested?.());

  // Positional alignment: PDF page k ↔ visible[k-1] (hints compacted to the
  // visible axes after hidden/empty slides were excluded upstream).
  const hintFor = (n) => hints[n - 1] ?? null;

  const work = async (page, n) => {
    if (cancelRequested()) { const err = new Error("job cancelled"); err.cancelled = true; throw err; }
    opts.onSlideStatus?.(n, "running");
    const pngPath = path.join(slidesDir, `${String(n).padStart(2, "0")}.png`);
    await renderPage(pdfPath, page.page, dpi, pngPath);
    const prev = slides[n - 2];
    const result = await analyzeSlide({
      n, total,
      prevTitle: prev && !prev.failed ? prev.json?.title ?? null : null,
      pngPath,
      textLayer: pageText(pages.find((p) => p.page === page.page)),
      nativeHints: stripMeta(hintFor(n)),
      provider, logger,
      jobId,
    });
    usage.input += result.usage?.input ?? 0; usage.output += result.usage?.output ?? 0;
    slides[n - 1] = result;
    opts.onSlideStatus?.(n, result.failed ? "failed" : "done");
    // Persist this slide's raw outcome so callers can progress incrementally.
    try {
      const slidePath = path.join(slidesDir, `${String(n).padStart(2, "0")}.json`);
      fs.writeFileSync(slidePath, JSON.stringify(result, null, 2));
    } catch (err) {
      logger?.warn?.(`failed to persist slide ${n} outcome: ${err?.message ?? err}`);
    }
    return result;
  };

  // Bounded pool. Concurrency is a process-wide knob (VLM_CONCURRENCY, default 3).
  const CONCURRENCY = Math.max(1, Number(process.env.VLM_CONCURRENCY ?? opts.concurrency ?? 3) || 3);
  const cancelCheck = () => Boolean(opts.cancelRequested?.());

  const indices = pages.map((_, i) => i); // pages in original order
  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, total) }, async () => {
    for (;;) {
      if (cancelCheck()) return;
      const idx = next;
      if (idx >= total) return;
      next += 1;
      const page = pages[idx];
      try {
        await work(page, idx + 1);
      } catch (err) {
        const cancelled = err?.cancelled;
        opts.onSlideStatus?.(idx + 1, cancelled ? "cancelled" : "failed");
        slides[idx] = { slide: idx + 1, failed: true, issues: [String(err?.message ?? err)], usage: { input: 0, output: 0 } };
      }
    }
  });
  await Promise.all(workers);

  const done = slides.filter(Boolean);
  const failed = done.filter((s) => s.failed).length;
  return { slides: done, usage, images, failed };
}
