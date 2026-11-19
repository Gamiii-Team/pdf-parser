// tests/rerun.test.js — re-run figures/tables flow + export stripping.
// Module-level tests use pure helpers; endpoint tests boot the real server against a seeded job.
// No Groq calls: the server is spawned with GROQ_API_KEY="" so any accidental call fails fast.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { execFileSync, spawn } from "node:child_process";

import { applyRerun, undoRerun } from "../src/slideMerge.js";
import { stripReviewOnly } from "../src/validate/slideSchema.js";
import { rerunFigures } from "../src/extract/slideVlm.js";

const silent = { info() {}, warn() {}, error() {} };

// ─────────────────────────── unit: merge helpers ───────────────────────────

const VLM_FIGURE = { type: "chart", title: "Rev", description: "bar chart", data: { labels: ["a"], series: [{ name: "s", values: [1] }] }, visible_text: ["1"], excluded: false, reviewer_note: "ok", bbox: [0.1, 0.1, 0.9, 0.9] };

test("applyRerun keeps reviewer-anchored exclusions verbatim, replaces the rest", () => {
  const slide = {
    slide: 1, title: "t", subtitle: null,
    text_blocks: [{ text: "keep", role: "body", level: 0 }],
    tables: [{ headers: ["old"], rows: [["old"]] }],
    figures: [
      { ...VLM_FIGURE, title: "keep-me", excluded: true, reviewer_note: "this is not a chart" },
      { ...VLM_FIGURE, title: "replace-me" },
    ],
    speaker_notes: "keep me", confidence: "low", issues: ["old issue"], reviewed: true, rerun_count: 1,
  };
  const out = applyRerun(slide, { figures: [{ ...VLM_FIGURE, title: "brand-new" }], tables: [{ headers: ["new"], rows: [["new"]] }] }, null);
  assert.deepEqual(out.figures.map((f) => f.title), ["keep-me", "brand-new"]);
  assert.equal(out.tables[0].headers[0], "new");
  assert.equal(out.text_blocks[0].text, "keep");
  assert.equal(out.speaker_notes, "keep me");
  assert.equal(out.reviewed, false);
  assert.equal(out.rerun_count, 2);
  assert.equal(out.previous.figures[1].title, "replace-me");
});

test("applyRerun undo restores the previous pair and decrements the counter", () => {
  const slide = { slide: 1, figures: [{ title: "A", excluded: true }, { title: "B" }], tables: [{ headers: ["t"] }], rerun_count: 2 };
  const rerun = applyRerun(slide, { figures: [{ title: "C" }], tables: [{ headers: ["u"] }] }, null);
  const restored = undoRerun(rerun);
  assert.deepEqual(restored.figures.map((f) => f.title), ["A", "B"]);
  assert.equal(restored.tables[0].headers[0], "t");
  // round-trip: applyRerun bumps 2→3, undoRerun restores 3→2
  assert.equal(restored.rerun_count, 2);
  assert.equal(restored.previous, undefined);
});

test("stripReviewOnly drops excluded figures and review-only fields", () => {
  const doc = {
    jobId: "x", input: "deck.pptx",
    slides: [{
      slide: 1, title: "kept", speaker_notes: "keep me", confidence: "high", reviewed: true, rerun_count: 3,
      previous: { figures: [], tables: [] },
      figures: [
        { ...VLM_FIGURE, title: "dropped", excluded: true },
        { ...VLM_FIGURE, title: "kept", reviewer_note: "five bars", bbox: [0.1, 0.1, 0.9, 0.9] },
      ],
      tables: [],
    }],
  };
  const clean = stripReviewOnly(doc);
  const s = clean.slides[0];
  assert.equal("reviewed" in s, false);
  assert.equal("rerun_count" in s, false);
  assert.equal("previous" in s, false);
  assert.deepEqual(s.figures.map((f) => f.title), ["kept"]);
  assert.equal(s.figures[0].reviewer_note, undefined);
  assert.equal(s.figures[0].bbox, undefined);
  assert.equal(s.figures[0].title, "kept"); // content preserved
  assert.equal(s.speaker_notes, "keep me"); // notes preserved
});

// ──────────────────── unit: rerunFigures via stubbed VLM ────────────────────

test("rerunFigures sends reviewer feedback and returns parsed figures/tables", async () => {
  const calls = [];
  const stubFigure = { type: "chart", title: "Rev", description: "bar chart with gridlines", data: { labels: ["a"], series: [] }, visible_text: ["Rev"] };
  const provider = {
    async complete(messages) {
      calls.push(messages);
      const user = messages[1].content.find((c) => c.type === "text").text;
      assert.ok(user.includes("<reviewer>"), "re-run prompt must carry the reviewer block");
      assert.ok(user.includes("Slide-level note: chart has five bars, not four"), "slide note must be verbatim");
      assert.ok(user.includes("figure 1: legend is missing"), "figure notes must be present");
      assert.ok(user.includes("NOT figures"), "excluded items must be listed");
      return { text: JSON.stringify({ figures: [stubFigure], tables: [{ headers: ["a"], rows: [["1"]] }] }), finishReason: "stop", usage: { input: 10, output: 5 } };
    },
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rerun-fig-stub-"));
  const png = path.join(tmp, "1.png");
  fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const currentSlide = {
    slide: 1,
    figures: [{ ...VLM_FIGURE, excluded: true, description: "a logo", type: "logo" }],
    tables: [],
  };
  const out = await rerunFigures({
    pngPath: png, currentSlide,
    slideNote: "chart has five bars, not four",
    figureNotes: [{ index: 0, note: "legend is missing" }],
    provider, logger: silent,
  });
  assert.equal(out.figures.length, 1);
  assert.equal(out.tables.length, 1);
  assert.ok(calls.length >= 1);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("rerunFigures throws on twice-malformed output (caller keeps old version)", async () => {
  const provider = {
    async complete() {
      return { text: "definitely not JSON", finishReason: "stop", usage: { input: 1, output: 1 } };
    },
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rerun-fig-bad-"));
  const png = path.join(tmp, "1.png");
  fs.writeFileSync(png, Buffer.from([0x89, 0x50]));
  await assert.rejects(
    rerunFigures({ pngPath: png, currentSlide: { slide: 1, figures: [], tables: [] }, slideNote: "", figureNotes: [], provider, logger: silent }),
    /re-run failed/,
  );
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ───────────────── endpoint negative paths via spawned server ─────────────────

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); });
  s.on("error", reject);
});

const API_SERVER = path.resolve("UI/server.mjs");
const VLM_ID = /^[0-9a-f]{16}$/;
const validSlide1 = {
  slide: 1, title: "t", subtitle: null,
  text_blocks: [], tables: [], figures: [],
  speaker_notes: null, confidence: "high", issues: [],
};

function seedJob(root, { slides }) {
  const jobId = "1111111111111111";
  const dir = path.join(root, "vlm", jobId, "vlm", "qwen3.8-27b");
  fs.mkdirSync(path.join(dir, "slides"), { recursive: true });
  fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ id: jobId, mode: "vlm", model: "qwen/qwen3.8-27b", input: "seed.pptx", created: Date.now(), updated: Date.now(), status: "review", slides: { 1: "done" }, issues: [] }));
  fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify({ jobId, mode: "vlm", model: "qwen/qwen3.8-27b", backend: "groq", input: "seed.pptx", created: Date.now(), slides }));
  fs.writeFileSync(path.join(dir, "hints.json"), "[]");
  fs.writeFileSync(path.join(dir, "slides", "01.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return jobId;
}

let tmp, server, base, jobId;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rerun-endpoints-"));
  jobId = seedJob(tmp, {
    slides: [{ ...validSlide1, rerun_count: 5 }], // hit the rate limit
  });
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [API_SERVER], {
    cwd: path.dirname(API_SERVER) + "/..",
    env: { ...process.env, OUTPUT_DIR: tmp, PORT: String(port), GROQ_API_KEY: "" },
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i += 1) {
    try { const r = await fetch(base + "/api/status"); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
});

after(() => {
  server?.kill("SIGTERM");
  fs.rmSync(tmp, { recursive: true, force: true });
});

const api = async (p, opts = {}) => {
  const r = await fetch(base + p, { headers: { "Content-Type": "application/json" }, ...opts });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
};

test("re-run is rate-limited at 5/slide — 429 without calling the model", async () => {
  const { status, body } = await api(`/api/jobs/${jobId}/slides/1/rerun`, {
    method: "POST", body: JSON.stringify({ slideNote: "x", figureNotes: [] }),
  });
  assert.equal(status, 429);
  assert.match(body.error ?? "", /re-run limit/);
});

test("slideNote over 1000 chars is rejected with 400 before any model call", async () => {
  // reseeding is avoided — the rate-limit slide already has rerun_count=5, but
  // the length check happens after it, so use a fresh slide with count 0 instead.
  seedJob(tmp, { slides: [{ ...validSlide1, rerun_count: 0 }] });
  const job2 = "1111111111111111"; // same seeded id from the helper
  const { status } = await api(`/api/jobs/${job2}/slides/1/rerun`, {
    method: "POST", body: JSON.stringify({ slideNote: "x".repeat(1001), figureNotes: [] }),
  });
  assert.equal(status, 400);
});

test("invalid job id and slide out of range are rejected", async () => {
  const bad = await api(`/api/jobs/not-an-id/slides/7/rerun`, { method: "POST", body: "{}" });
  assert.equal(bad.status, 400);
  const zero = await api(`/api/jobs/${jobId}/slides/0/rerun`, { method: "POST", body: "{}" });
  assert.equal(zero.status, 400);
});

test("undo-rerun with no previous re-run returns 400", async () => {
  // slide 7 has no previous pair seeded
  const { status, body } = await api(`/api/jobs/${jobId}/slides/1/undo-rerun`, { method: "POST", body: "{}" });
  assert.equal(status, 400);
  assert.match(body.error ?? "", /nothing to undo/);
});
