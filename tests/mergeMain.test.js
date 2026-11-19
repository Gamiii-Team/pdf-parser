// tests/mergeMain.test.js — queue computation, main.json atomic merge, review_status markers.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { computeQueue, mergeSlides, writeMainAtomic, buildStatusSlideMap } from "../src/mergeMain.js";

const mkSlide = (n, overrides = {}) => ({
  slide: n, title: `Slide ${n}`, subtitle: null,
  text_blocks: [{ text: `Block ${n}`, role: "body", level: 0 }],
  tables: [], figures: [],
  speaker_notes: null, confidence: "high", issues: [],
  ...overrides,
});

test("queue: text-only slides are auto; figure or table slides are queued", () => {
  const slides = [
    mkSlide(1),
    mkSlide(2, { figures: [{ type: "chart", description: "bar" }] }),
    mkSlide(3, { tables: [{ headers: ["a"], rows: [["1"]] }] }),
  ];
  const { queued, auto } = computeQueue(slides, null);
  assert.deepEqual(queued, [2, 3]);
  assert.deepEqual(auto, [1]);
});

test("queue: a picture-hint forces the slide into queue even without model figures", () => {
  const slides = [mkSlide(1), mkSlide(2), mkSlide(3)];
  const hints = [{ slide: 1, pictures: [] }, { slide: 2, pictures: [{ alt: "", bbox: [0, 0, 1, 1] }] }, { slide: 3, tables: [{ rows: [["x"]], bbox: [0, 0, 1, 1] }] }];
  const { queued, auto } = computeQueue(slides, hints);
  assert.deepEqual(queued, [2, 3]);
  assert.deepEqual(auto, [1]);
});

test("queue: a failed slide with no figures or tables is still queued", () => {
  const slides = [mkSlide(1, { failed: true }), mkSlide(2)];
  const { queued, auto } = computeQueue(slides, null);
  assert.deepEqual(queued, [1]);
  assert.deepEqual(auto, [2]);
});

test("buildStatusSlideMap: mixed slides get the right vocabulary", () => {
  const slides = [
    mkSlide(1),                                // auto
    mkSlide(2, { figures: [{ type: "chart" }] }), // queued
    mkSlide(3),                                // auto
    mkSlide(4, { failed: true }),               // failed (but still queued in vocab maps to 'failed')
  ];
  const map = buildStatusSlideMap(slides, null);
  assert.equal(map[1], "auto");
  assert.equal(map[2], "queued");
  assert.equal(map[3], "auto");
  assert.equal(map[4], "failed");
});

test("mergeSlides: no pending markers once slides are auto/approved; pending otherwise", () => {
  const result = {
    jobId: "j", mode: "vlm", model: "m", backend: "groq", input: "deck.pptx", created: 1,
    slides: [mkSlide(1), mkSlide(2, { figures: [{ type: "chart", description: "d" }] }), mkSlide(3)],
  };
  const merged = mergeSlides(result, { 1: "auto", 2: "queued", 3: "approved" });
  assert.equal(merged.slides[0].review_status, undefined, "auto slide — no marker");
  assert.equal(merged.slides[1].review_status, "pending", "queued unapproved — pending marker");
  assert.equal(merged.slides[2].review_status, undefined, "approved slide — no marker");
});

test("mergeSlides: strips review-only fields and drops excluded figures but keeps visible_text", () => {
  const result = {
    jobId: "j", mode: "vlm", model: "m", backend: "groq", input: "deck.pptx", created: 1,
    slides: [
      mkSlide(1, { figures: [
        { type: "chart", title: "kept", description: "keep", data: { labels: [], series: [] }, visible_text: ["a"], excluded: false, bbox: [0.1, 0.1, 0.9, 0.9], bbox_locked: true, reviewer_note: "mine" },
        { type: "logo", description: "drop me", data: { labels: [], series: [] }, visible_text: [], excluded: true },
        { type: "image", description: "keep", data: { labels: [], series: [] }, visible_text: ["b"], previous: { figures: [], tables: [] }, rerun_count: 7, reviewed: true },
      ] }),
    ],
  };
  const merged = mergeSlides(result, { 1: "queued" });
  const figs = merged.slides[0].figures;
  assert.equal(figs.length, 2, "excluded figure dropped, others retained");
  for (const f of figs) {
    assert.equal("excluded" in f, false);
    assert.equal("bbox" in f, false);
    assert.equal("bbox_locked" in f, false);
    assert.equal("bbox_source" in f, false);
    assert.equal("reviewer_note" in f, false);
    assert.equal("previous" in f, false);
    assert.equal("reviewed" in f, false);
    assert.equal("rerun_count" in f, false);
  }
  assert.deepEqual(figs.map((f) => f.title ?? f.description), ["kept", "keep"]);
});

test("mergeSlides: failed slides survive with the failed:true marker and no review_status", () => {
  const result = {
    jobId: "j", mode: "vlm", model: "m", backend: "groq", input: "deck.pptx", created: 1,
    slides: [{ slide: 1, failed: true, issues: ["provider returned 429"] }],
  };
  const merged = mergeSlides(result, { 1: "failed" });
  assert.equal(merged.slides[0].failed, true);
  assert.deepEqual(merged.slides[0].issues, ["provider returned 429"]);
  assert.equal("review_status" in merged.slides[0], false);
});

test("writeMainAtomic: target exists, no temp files linger, content parses", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "merge-atomic-"));
  const main = { jobId: "j", slides: [{ slide: 1 }] };
  const out = writeMainAtomic(tmp, main);
  assert.equal(fs.existsSync(out), true);
  assert.deepEqual(fs.readdirSync(tmp).filter((f) => f.startsWith(".main.json.tmp")), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf8")), main);
  fs.rmSync(tmp, { recursive: true, force: true });
});
