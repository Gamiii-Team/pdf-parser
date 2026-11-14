// tests/pageImage.test.js — the shared full-modal/full-groq page pipeline,
// driven by a mock provider (no network, no API keys).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { extractPageElements } from "../src/modes/pageImage.js";
import { FileCache } from "../src/util/cache.js";
import { fileURLToPath } from "node:url";

const GOOD = JSON.stringify({
  elements: [
    { type: "heading", text: "Title", level: 1, bbox: [0.1, 0.05, 0.9, 0.1] },
    { type: "paragraph", text: "A short body paragraph.", bbox: [0.1, 0.15, 0.9, 0.25] },
    { type: "figure", figure_type: "bar_chart", description: "A chart", caption: null, bbox: [0.1, 0.3, 0.9, 0.6], data: null },
  ],
  page_notes: "",
});

const GOOD_WITH_TABLE = JSON.stringify({
  elements: [
    { type: "table", rows: [["A", "B"], ["1", "2"]], header_rows: 1, bbox: [0.1, 0.1, 0.9, 0.4], caption: "Table 1: test" },
  ],
});

function makeMock(behavior) {
  // behavior: async (messages, callNumber) => ({ text, finishReason, usage })
  let calls = 0;
  return {
    name: "groq",
    model: "mock-model",
    calls: () => calls,
    complete: async (messages, opts) => {
      calls += 1;
      return behavior(messages, calls, opts);
    },
  };
}

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };
const tmpCache = () => new FileCache(fs.mkdtempSync(path.join(os.tmpdir(), "extract-cache-")));

test("parses a clean response into normalized elements", async () => {
  const mock = makeMock(async () => ({ text: GOOD, finishReason: "stop", usage: { input: 100, output: 50 } }));
  const result = await extractPageElements({
    provider: mock, page: 1, jpeg: Buffer.from("jpeg-bytes"), mode: "full-groq",
    cache: tmpCache(), logger: quietLogger,
  });
  assert.equal(result.finishReason, "stop");
  assert.equal(result.elements.length, 3);
  assert.equal(result.elements[0].type, "heading");
  assert.equal(result.elements[1].text, "A short body paragraph.");
  assert.equal(result.elements[2].figure_type, "bar_chart");
  assert.equal(result.elements[2].source, "groq");
  assert.equal(result.retries, 0);
});

test("strips think tags and json fences before parsing", async () => {
  const wrapped = `<think>reasoning that should be ignored</think>\n\`\`\`json\n${GOOD}\n\`\`\``;
  const mock = makeMock(async () => ({ text: wrapped, finishReason: "stop", usage: { input: 1, output: 1 } }));
  const result = await extractPageElements({
    provider: mock, page: 1, jpeg: Buffer.from("img"), mode: "full-groq",
    cache: tmpCache(), logger: quietLogger,
  });
  assert.equal(result.elements.length, 3);
});

test("retries with validation feedback, then succeeds", async () => {
  const mock = makeMock(async (_msgs, call) => {
    if (call === 1) return { text: "{not valid json", finishReason: "stop", usage: { input: 1, output: 1 } };
    return { text: GOOD_WITH_TABLE, finishReason: "stop", usage: { input: 2, output: 2 } };
  });
  const result = await extractPageElements({
    provider: mock, page: 2, jpeg: Buffer.from("img2"), mode: "full-groq",
    cache: tmpCache(), logger: quietLogger,
  });
  assert.equal(mock.calls(), 2);
  assert.equal(result.elements[0].type, "table");
  assert.deepEqual(result.elements[0].rows, [["A", "B"], ["1", "2"]]);
  assert.equal(result.retries, 1);
});

test("persistent failure falls back to a needs_review placeholder and is NOT cached", async () => {
  const mock = makeMock(async () => ({ text: "garbage", finishReason: "stop", usage: { input: 1, output: 1 } }));
  const cache = tmpCache();
  const result = await extractPageElements({
    provider: mock, page: 3, jpeg: Buffer.from("img3"), mode: "full-groq",
    cache, logger: quietLogger,
  });
  assert.equal(result.finishReason, "failed");
  assert.equal(result.elements.length, 1);
  assert.equal(result.elements[0].needs_review, true);
  assert.match(result.elements[0].error, /extraction_failed|schema/);
  const second = await extractPageElements({
    provider: mock, page: 3, jpeg: Buffer.from("img3"), mode: "full-groq",
    cache, logger: quietLogger,
  });
  // Fallback is not cached: provider gets called again.
  assert.equal(mock.calls(), (3 + 1) * 2); // (retries+1) calls per invocation
  assert.equal(second.finishReason, "failed");
});

test("finish_reason=length is surfaced as truncated", async () => {
  const mock = makeMock(async () => ({ text: GOOD, finishReason: "length", usage: { input: 1, output: 9999 } }));
  const result = await extractPageElements({
    provider: mock, page: 4, jpeg: Buffer.from("img4"), mode: "full-groq",
    cache: tmpCache(), logger: quietLogger,
  });
  assert.equal(result.truncated, true);
});

test("dense-page fallback: whole page fails, halves succeed, bottom half is shifted", async () => {
  const HALF_TOP = JSON.stringify({
    elements: [{ type: "paragraph", text: "top half content", bbox: [0.1, 0.1, 0.9, 0.3] }],
  });
  const HALF_BOTTOM = JSON.stringify({
    elements: [{ type: "paragraph", text: "bottom half content", bbox: [0.1, 0.1, 0.9, 0.3] }],
  });
  const mock = makeMock(async (_msgs, call) => {
    // retries=3 -> 4 whole-page attempts all fail; the two halves succeed.
    if (call <= 4) return { text: "not json at all", finishReason: "stop", usage: { input: 1, output: 1 } };
    if (call === 5) return { text: HALF_TOP, finishReason: "stop", usage: { input: 50, output: 25 } };
    return { text: HALF_BOTTOM, finishReason: "stop", usage: { input: 50, output: 25 } };
  });
  const result = await extractPageElements({
    provider: mock, page: 1, jpeg: Buffer.from("fake-jpeg"), mode: "full-groq",
    cache: tmpCache(), logger: quietLogger,
    pdfPath: fileURLToPath(new URL("../test.pdf", import.meta.url)),
    dpi: 100,
  });
  assert.equal(result.halved, true);
  assert.ok(result.elements.length >= 2, "both halves contribute elements");
  const top = result.elements.find((el) => el.text === "top half content");
  const bottom = result.elements.find((el) => el.text === "bottom half content");
  assert.ok(top.bbox[3] <= 0.6, `top half stays high on the page (${top.bbox})`);
  assert.ok(bottom.bbox[1] > 0.4, `bottom half is shifted down (${bottom.bbox})`);
  assert.equal(result.usage.input, 100); // 2 halves x 50
});

test("cache hit avoids calling the provider again", async () => {
  const cache = tmpCache();
  const mock = makeMock(async () => ({ text: GOOD, finishReason: "stop", usage: { input: 1, output: 1 } }));
  await extractPageElements({ provider: mock, page: 5, jpeg: Buffer.from("img5"), mode: "full-groq", cache, logger: quietLogger });
  const second = await extractPageElements({ provider: mock, page: 5, jpeg: Buffer.from("img5"), mode: "full-groq", cache, logger: quietLogger });
  assert.equal(second.cacheHit, true);
  assert.equal(mock.calls(), 1);
});

test("different modes/models get different cache entries", async () => {
  const cache = tmpCache();
  const mock = makeMock(async () => ({ text: GOOD, finishReason: "stop", usage: { input: 1, output: 1 } }));
  await extractPageElements({ provider: mock, page: 6, jpeg: Buffer.from("img6"), mode: "full-groq", cache, logger: quietLogger });
  const otherMode = await extractPageElements({ provider: mock, page: 6, jpeg: Buffer.from("img6"), mode: "full-modal", cache, logger: quietLogger });
  assert.equal(otherMode.cacheHit, false);
  assert.equal(mock.calls(), 2);
});
