// src/zoom.js — zoom pass: read dense figures at high DPI in a 2x2 tile grid.
// Pure helpers (tiles, dedup) are exported for unit tests; the endpoint is thin.

import fs from "node:fs";

/** 2x2 tile boxes with ~10% overlap, kept inside the original figure box. */
export function tiles2x2(box) {
  const [x0, y0, x1, y1] = box;
  const sx = x1 - x0, sy = y1 - y0;
  const SPAN = 0.55, STEP = 0.45;
  const out = [];
  for (const tx of [0, 1]) for (const ty of [0, 1]) {
    out.push([
      x0 + sx * (tx * STEP),
      y0 + sy * (ty * STEP),
      x0 + sx * (tx * STEP) + sx * SPAN,
      y0 + sy * (ty * STEP) + sy * SPAN,
    ]);
  }
  return out;
}

/** Merge visible_text from the full crop and each tile; dedup exact strings, keep first occurrence order. */
export function mergeVisibleText(base, tileLists) {
  const merged = new Map((base ?? []).map((t) => [String(t).trim(), t]));
  for (const list of tileLists) {
    for (const t of list ?? []) {
      const key = String(t).trim();
      if (key && !merged.has(key)) merged.set(key, t);
    }
  }
  return [...merged.values()];
}

function parseJsonLoose(text) {
  const cleaned = String(text).replace(/```json|```/g, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  return JSON.parse(match ? match[0] : cleaned);
}

/**
 * Read every tile with the VLM (full crop as context) and return the raw per-tile lists.
 * Failing tiles are tolerated and contribute [].
 */
export async function zoomTilesWithVlm({ provider, fullCropPath, tilePaths, logger }) {
  const fullB64 = fs.readFileSync(fullCropPath).toString("base64");
  const tileLists = [];
  for (const [i, tilePath] of tilePaths.entries()) {
    const tileB64 = fs.readFileSync(tilePath).toString("base64");
    const userText = [
      "Image 1 is the complete figure (context). Image 2 is one tile of it.",
      "Return JSON {\"visible_text\": [...]} with every piece of text visible in the TILE, in reading order.",
      "If some text is too small to read, omit it rather than guess.",
    ].join("\n");
    let done = false;
    for (let attempt = 0; attempt < 2 && !done; attempt += 1) {
      try {
        const { text } = await provider.complete([
          { role: "system", content: "You read images of document pages and return ONLY a JSON object." },
          { role: "user", content: [
            { type: "text", text: userText + (attempt === 1 ? "\nReminder: output ONLY the JSON object." : "") },
            { type: "image_url", image_url: { url: `data:image/png;base64,${fullB64}` } },
            { type: "image_url", image_url: { url: `data:image/png;base64,${tileB64}` } },
          ] },
        ], { maxTokens: 2048, temperature: 0.1 });
        const parsed = parseJsonLoose(text);
        if (!Array.isArray(parsed?.visible_text)) throw new Error("tile response missing visible_text");
        tileLists.push(parsed.visible_text.map((t) => String(t)));
        done = true;
      } catch (err) {
        logger?.warn?.(`zoom tile ${i + 1} failed: ${err?.message ?? err}`);
      }
    }
    if (!done) tileLists.push([]);
  }
  return tileLists;
}
