// tests/eta.test.js — ETA estimate + formatting (src/eta.js).

import { test } from "node:test";
import assert from "node:assert/strict";

import { etaFor, formatEtaMs } from "../src/eta.js";

test("cold start yields no estimate", () => {
  assert.equal(etaFor({ done: 1, total: 10, startedAt: 0, now: 10_000 }), null);
});

test("estimate appears once enough samples exist", () => {
  // 3 slides in 60s → 27 remaining ≈ 540s, rounded to 5s
  assert.equal(etaFor({ done: 3, total: 30, startedAt: 0, now: 60_000 }), 540_000);
});

test("estimate appears after the elapsed floor even with few samples", () => {
  assert.equal(etaFor({ done: 1, total: 10, startedAt: 0, now: 21_000 }), 190_000); // 9 remaining, rounded to 5s
});

test("unknown total, zero done, or missing start → null", () => {
  assert.equal(etaFor({ done: 0, total: 10, startedAt: 0, now: 60_000 }), null);
  assert.equal(etaFor({ done: 3, total: 0, startedAt: 0, now: 60_000 }), null);
  assert.equal(etaFor({ done: 3, total: 10, startedAt: null, now: 60_000 }), null);
});

test("finished and clamped estimates", () => {
  assert.equal(etaFor({ done: 10, total: 10, startedAt: 0, now: 60_000 }), 0);
  assert.equal(etaFor({ done: 1, total: 1_000_000, startedAt: 0, now: 60_000 }), 2 * 60 * 60 * 1000);
});

test("formatEtaMs renders human text", () => {
  assert.equal(formatEtaMs(null), "estimating…");
  assert.equal(formatEtaMs(0), "done");
  assert.equal(formatEtaMs(30_000), "~30 s left");
  assert.equal(formatEtaMs(240_000), "~4 min left");
  assert.equal(formatEtaMs(3_900_000), "~1 h 5 min left");
});
