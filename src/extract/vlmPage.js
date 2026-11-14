// src/extract/vlmPage.js
// VLM page path (§2b): render a page to PNG, run the page prompt through the
// configured provider, and normalize the returned block list.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { config } from "../config.js";
import { renderPage } from "../pymupdf/run.js";

const CAP_ALLOWED_TYPES = new Set(["heading", "text", "list", "table", "chart", "notes"]);

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

function toDataUrl(buffer, mime = "image/png") {
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

function loadPrompt() {
  return fs.readFileSync(new URL("../prompts/page.prompt.md", import.meta.url), "utf8");
}

const asStringList = (value) =>
  Array.isArray(value) ? value.map((v) => String(v ?? "").trim()) : [];

function normalizeBlock(raw, page) {
  if (!raw || typeof raw !== "object") return null;
  const type = String(raw.type ?? "").trim().toLowerCase();
  if (!CAP_ALLOWED_TYPES.has(type)) return null;

  const common = { page, bbox: null, caption: raw.caption ?? null, needs_review: raw.needs_review === true };

  switch (type) {
    case "heading":
      return { ...common, type: "heading", level: Math.max(1, Math.min(3, Number(raw.level) || 1)), content: String(raw.text ?? raw.content ?? "").trim() };
    case "text":
      return { ...common, type: "text", content: String(raw.text ?? raw.content ?? "").trim() };
    case "notes":
      return { ...common, type: "notes", content: String(raw.text ?? raw.content ?? "").trim() };
    case "list": {
      const items = asStringList(raw.items);
      if (!items.length) {
        const t = String(raw.text ?? "").trim();
        if (t) items.push(t); else return null;
      }
      return { ...common, type: "list", items };
    }
    case "table": {
      const columns = asStringList(raw.columns);
      const rows = Array.isArray(raw.rows)
        ? raw.rows.map((r) => asStringList(r))
        : [];
      return {
        ...common,
        type: "table",
        header_rows: columns.length ? 1 : 0,
        content: { columns, rows },
      };
    }
    case "chart": {
      const rawType = String(raw.chart_type ?? "other").toLowerCase();
      const allowed = new Set(["bar", "line", "pie", "scatter", "table-image", "diagram", "photo", "other"]);
      return {
        ...common,
        type: "chart",
        chart_type: allowed.has(rawType) ? rawType : "other",
        title: raw.title ?? null,
        description: raw.description ?? null,
        content: raw.content ?? null,
        estimates: raw.estimates === true,
      };
    }
    default:
      return null;
  }
}

/**
 * Process every VLM-routed page.
 * @returns {Promise<{ blocks: object[], usage: { input: number, output: number }, errors: string[] }>}
 */
export async function extractVlmPages({ pdfPath, vlmPages, provider, logger }) {
  const usage = { input: 0, output: 0 };
  const errors = [];
  const blocks = [];
  if (!provider) {
    for (const p of vlmPages ?? []) {
      errors.push(`page ${p.page}: VLM required but provider is not available — block skipped`);
      blocks.push({ type: "notes", page: p.page, bbox: null, caption: null, needs_review: true, content: `VLM route selected but no provider/backend was configured for this page (model unavailable).` });
    }
    return { blocks, usage, errors };
  }

  const prompt = loadPrompt();
  const tmpDir = path.join(os.tmpdir(), `docv2-vlm-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  for (const p of vlmPages ?? []) {
    try {
      const outPath = path.join(tmpDir, `page-${p.page}.png`);
      await renderPage(pdfPath, p.page, config.dpi, outPath);
      const buffer = fs.readFileSync(outPath);
      const dataUrl = toDataUrl(buffer, "image/png");

      const messages = [{
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      }];

      const { text, finishReason, usage: u } = await provider.complete(messages, { maxTokens: 8192, temperature: 0.1 });
      usage.input += u?.input ?? 0;
      usage.output += u?.output ?? 0;

      const parsed = parseModelJson(text);
      const rawBlocks = Array.isArray(parsed.blocks) ? parsed.blocks : [];
      let added = 0;
      for (const raw of rawBlocks) {
        const normalized = normalizeBlock(raw, p.page);
        if (normalized) { blocks.push(normalized); added += 1; }
      }
      logger?.info?.(`vlm page ${p.page}: ${added} block(s) (${finishReason})`);
    } catch (err) {
      errors.push(`page ${p.page}: ${err.message}`);
      blocks.push({ type: "notes", page: p.page, bbox: null, caption: null, needs_review: true, content: `VLM page failed: ${err.message}` });
    }
  }

  return { blocks, usage, errors };
}
