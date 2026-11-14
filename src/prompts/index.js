// src/prompts/index.js
// Prompt loader. Prompts live in versioned .prompt.md files in this directory,
// never inline in code. PROMPT_VERSION in config.js must be bumped when any
// prompt changes (it is part of the cache key).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));

const CACHE = new Map();

export function loadPrompt(name) {
  if (CACHE.has(name)) return CACHE.get(name);
  const file = path.join(DIR, `${name}.prompt.md`);
  const text = fs.readFileSync(file, "utf8");
  CACHE.set(name, text);
  return text;
}

export function fillPrompt(template, vars) {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`{{${key}}}`, value ?? "");
  }
  return out;
}

/** Build the full page-extraction prompt (page image + optional text hint). */
export function buildPagePrompt({ hintText = null } = {}) {
  const template = loadPrompt("page");
  const hint = hintText && hintText.trim().length > 0
    ? `=== TEXT LAYER HINT (use only to fix misread words) ===\n${hintText.trim()}`
    : "";
  return fillPrompt(template, { HINT: hint });
}

const FIGURE_PROMPTS = {
  bar_chart: "figure-chart",
  line_chart: "figure-chart",
  scatter: "figure-chart",
  pie_chart: "figure-chart",
  flowchart: "figure-flowchart",
  uml: "figure-flowchart",
  schematic: "figure-flowchart",
  photo: "figure-photo",
  screenshot: "figure-photo",
  table_image: "figure-photo",
  other: "figure-photo",
};

/** Build the type-specific figure-pass prompt. */
export function buildFigurePrompt(figureType, { caption = null } = {}) {
  const name = FIGURE_PROMPTS[figureType] ?? "figure-photo";
  const template = loadPrompt(name);
  const captionLine = caption ? `Nearest caption: ${caption}` : "Nearest caption: (none)";
  return fillPrompt(template, { CAPTION: captionLine });
}
