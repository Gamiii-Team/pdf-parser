// tests/translate.test.js — figure→English translation helper (stub provider, no Groq).
// Uses a tiny in-memory PNG (content irrelevant — translateFigure only base64s it).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { translateFigure, translateSlideText } from "../src/extract/slideVlm.js";

// 1x1 transparent PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l6cAAAAASUVORK5CYII=",
  "base64",
);

function tmpCrop() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "translate-test-"));
  const p = path.join(dir, "crop.png");
  fs.writeFileSync(p, PNG);
  return { dir, p };
}

test("translateFigure returns English prose fields, preserving the figure's data shape", async () => {
  const { dir, p } = tmpCrop();
  try {
    let seenFigure = null;
    const provider = {
      async complete(messages) {
        const text = messages?.[1]?.content?.find((c) => c.type === "text")?.text ?? "";
        seenFigure = JSON.parse(text.match(/<current>([\s\S]*)<\/current>/)?.[1] ?? "{}");
        return {
          text: JSON.stringify({
            title: "Quarterly revenue by region",
            description: "A bar chart showing quarterly revenue across four regions.",
            visible_text: ["Region", "Revenue", "North", "South"],
          }),
          finishReason: "stop",
          usage: { input: 10, output: 8 },
        };
      },
    };
    const fig = {
      title: "Ingresos trimestrales",
      description: "Gráfico de barras con los ingresos.",
      visible_text: ["Región", "Ingresos"],
      data: { labels: ["N", "S"], series: [] },
    };
    const out = await translateFigure({ cropPath: p, figure: fig, provider, logger: { warn() {} } });
    assert.equal(out.title, "Quarterly revenue by region");
    assert.match(out.description, /bar chart/i);
    assert.deepEqual(out.visible_text, ["Region", "Revenue", "North", "South"]);
    // Only the current prose fields are sent to the model — data/bbox/notes stay local.
    assert.deepEqual(Object.keys(seenFigure).sort(), ["description", "title", "visible_text"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("translateSlideText translates all prose fields, preserving block count and order", async () => {
  const { dir, p } = tmpCrop();
  try {
    let seen = null;
    const provider = {
      async complete(messages) {
        const text = messages?.[1]?.content?.find((c) => c.type === "text")?.text ?? "";
        seen = JSON.parse(text.match(/<current>([\s\S]*)<\/current>/)?.[1] ?? "{}");
        return {
          text: JSON.stringify({
            title: "Quarterly review",
            subtitle: "Fiscal results",
            text_blocks: ["Revenue grew steadily", "Margins improved"],
            speaker_notes: "Mention the new regions.",
          }),
          finishReason: "stop",
          usage: { input: 20, output: 15 },
        };
      },
    };
    const slide = {
      slide: 1,
      title: "Revision trimestrielle",
      subtitle: "Résultats fiscaux",
      text_blocks: [
        { text: "Les revenus ont augmenté", role: "body", level: 0 },
        { text: "Les marges se sont améliorées", role: "bullet", level: 1 },
      ],
      speaker_notes: "Mentionnez les nouvelles régions.",
    };
    const out = await translateSlideText({ pngPath: p, slide, provider, logger: { warn() {} } });
    assert.equal(out.title, "Quarterly review");
    assert.equal(out.subtitle, "Fiscal results");
    assert.deepEqual(out.text_blocks, ["Revenue grew steadily", "Margins improved"]);
    assert.equal(out.speaker_notes, "Mention the new regions.");
    // Caller receives exactly one string per input block in order.
    assert.deepEqual(seen.text_blocks, ["Les revenus ont augmenté", "Les marges se sont améliorées"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("translateSlideText retries once and throws on wrong block count", async () => {
  const { dir, p } = tmpCrop();
  try {
    let calls = 0;
    const provider = {
      async complete() {
        calls += 1;
        return {
          text: JSON.stringify({ title: "t", subtitle: null, text_blocks: ["only one"], speaker_notes: null }),
          finishReason: "stop",
          usage: { input: 1, output: 1 },
        };
      },
    };
    await assert.rejects(
      translateSlideText({ pngPath: p, slide: { text_blocks: [{ text: "a" }, { text: "b" }] }, provider, logger: { warn() {} } }),
      /translate-slide failed/,
    );
    assert.equal(calls, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("translateFigure retries once and throws on persistent malformed output", async () => {
  const { dir, p } = tmpCrop();
  try {
    let calls = 0;
    const provider = {
      async complete() {
        calls += 1;
        return { text: "not JSON at all", finishReason: "stop", usage: { input: 1, output: 1 } };
      },
    };
    await assert.rejects(
      translateFigure({ cropPath: p, figure: {}, provider, logger: { warn() {} } }),
      /translate failed/,
    );
    assert.equal(calls, 2, "two attempts before giving up");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
