// src/figureAnalyzer/vlm.js
// VLM implementation of the figure-analyzer interface (Groq or Modal-vLLM).
// Crops the figure from the rendered page and asks the model for the
// type-specific structured payload (chart data / flowchart nodes+edges /
// photo description). Swappable with the Florence analyzer.

import { buildFigurePrompt } from "../prompts/index.js";
import { toDataUrl, renderPage } from "../render.js";
import { clampBBox } from "../elements.js";

function sourceFor(providerName) {
  return providerName === "groq" ? "groq" : "qwen-vl";
}

function parseFigureJson(text) {
  if (!text) throw new Error("empty figure response");
  let cleaned = String(text).replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) cleaned = fence[1].trim();
  const start = cleaned.indexOf("{");
  if (start === -1) throw new Error("no JSON object in figure response");
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inStr) {
      if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") { depth -= 1; if (depth === 0) return JSON.parse(cleaned.slice(start, i + 1)); }
  }
  throw new Error("unbalanced JSON in figure response");
}

/**
 * @param {{ provider: {complete: Function, model: string, name: string} }} deps
 */
export function createVlmAnalyzer(provider) {
  return {
    name: provider.name === "groq" ? "groq" : "vllm",
    /**
     * @param {{label?: string, caption?: string|null, bbox: number[], page: number, figure_type?: string, pdfPath: string, dpi: number, pageWidthPx: number, pageHeightPx: number}} args
     */
    async analyze({ bbox, caption, page, figure_type, pdfPath, dpi, pageWidthPx, pageHeightPx }) {
      const [x0, y0, x1, y1] = clampBBox(bbox) ?? [0, 0, 1, 1];
      const crop = {
        x: Math.max(0, Math.floor(x0 * pageWidthPx)),
        y: Math.max(0, Math.floor(y0 * pageHeightPx)),
        width: Math.max(8, Math.floor((x1 - x0) * pageWidthPx)),
        height: Math.max(8, Math.floor((y1 - y0) * pageHeightPx)),
      };
      const cropped = await renderPage(pdfPath, page, { dpi, crop });
      const figureType = figure_type && figure_type !== "other" ? figure_type : "other";
      const prompt = buildFigurePrompt(figureType, { caption });
      const { text, finishReason } = await provider.complete(
        [{
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: toDataUrl(cropped, "image/jpeg") } },
          ],
        }],
        { maxTokens: 2048, temperature: 0.1 },
      );
      const parsed = parseFigureJson(text);
      return {
        figure_type: typeof parsed.figure_type === "string" && parsed.figure_type.trim() ? parsed.figure_type.trim() : figureType,
        description: String(parsed.description ?? ""),
        data: parsed.data && typeof parsed.data === "object" ? parsed.data : null,
        needs_review: finishReason === "length",
      };
    },
  };
}
