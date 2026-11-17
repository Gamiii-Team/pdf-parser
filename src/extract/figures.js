// src/extract/figures.js
// Figure analyzer: crops each figure region, runs the figure prompt,
// merges the structured data back into the manifest block.
// Set `figurePass=false` to skip entirely (e.g. for local smoke testing).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { config } from "../config.js";
import { cropRegion } from "../pymupdf/run.js";

const DEFAULT_MAX_DIM = 1600;

function toDataUrl(buffer, mime = "image/jpeg") {
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

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

function loadPrompt() {
  return fs.readFileSync(new URL("../prompts/figure.prompt.md", import.meta.url), "utf8");
}

/**
 * @param {Array<object>} figureBlocks  blocks with type starting with "figure"
 * @param {{ pdfPath: string, provider: object, logger: object, maxDim?: number }} opts
 * @returns {Promise<Array<object>>} figure blocks with content/table/chart fields
 */
export async function analyzeFigures(figureBlocks, { pdfPath, provider, logger, maxDim }) {
  // Returns { figures, usage, errors }.
  const tmpDir = path.join(os.tmpdir(), `docv2-fig-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const prompt = loadPrompt();
  const out = [];
  const usage = { input: 0, output: 0 };
  const errors = [];

  for (const figure of figureBlocks) {
    const ff = { ...figure };
    try {
      const [x0, y0, x1, y1] = figure.bbox;
      const cropPath = path.join(tmpDir, `figure-p${figure.page}-${Date.now()}.jpg`);
      await cropRegion(pdfPath, figure.page, x0, y0, x1, y1, config.cropDpi, cropPath);
      const buffer = fs.readFileSync(cropPath);
      const dataUrl = toDataUrl(buffer, "image/jpeg");
      const captionText = figure.caption ? `\nNearest caption: ${figure.caption}` : "";

      const messages = [{
        role: "user",
        content: [
          { type: "text", text: prompt + captionText },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      }];

      const { text, finishReason, usage: u } = await provider.complete(messages, { maxTokens: 2048, temperature: 0.1 });
      usage.input += u?.input ?? 0;
      usage.output += u?.output ?? 0;
      const parsed = parseModelJson(text);
      ff.chart_type = parsed.chart_type ?? ff.chart_type ?? "other";
      ff.title = parsed.title ?? ff.title ?? null;
      ff.description = parsed.description ?? ff.description ?? null;
      ff.content = parsed.content ?? ff.content ?? null;
      ff.estimates = parsed.estimates === true;
      ff.needs_review = parsed.needs_review === true;
      ff.finish_reason = finishReason;
      // `type` stays figure-image / figure-vector until tree-builder mapping
    } catch (err) {
      logger?.warn?.(`figure pass failed on page ${figure.page}: ${err.message}`);
      ff.needs_review = true;
      ff.notes = `figure_pass_failed: ${err.message}`;
      errors.push(`page ${figure.page}: ${err.message}`);
    }
    out.push(ff);
  }
  return { figures: out, usage, errors };
}
