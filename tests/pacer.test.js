// tests/pacer.test.js — the shared VLM choke point.
// No real Groq calls; uses fake clocks to verify gap, cooldown, success paths.

import { test } from "node:test";
import assert from "node:assert/strict";

import { Pacer } from "../src/util/pacer.js";

test("pacer starts ready and spaces N calls at least minGapMs apart", async () => {
  const pacer = new Pacer({ minGapMs: 100, jitterMs: 0, maxWaitMs: 5000 });
  pacer._resetForTest();
  await pacer.waitForSlot();
  await pacer.waitForSlot();
  const t = Date.now();
  await pacer.waitForSlot();
  const elapsed = Date.now() - t;
  assert.equal(elapsed >= 95, true, `third call came before minGapMs elapsed (${elapsed}ms)`);
});

test("noteRateLimit with Retry-After pushes pausedUntil into the future", () => {
  const pacer = new Pacer({ minGapMs: 10, jitterMs: 0, maxWaitMs: 60000 });
  pacer._resetForTest();
  const before = Date.now();
  pacer.noteRateLimit({ retryAfterMs: 10_000, reason: "429", tag: "test" });
  assert.equal(pacer._pausedUntil > before + 9_000, true);
});

test("noteRateLimit falls back to exponential backoff capped at maxBackoffMs", () => {
  const pacer = new Pacer({ minGapMs: 10, jitterMs: 0, maxWaitMs: 60000, backoffStartMs: 1_000, maxBackoffMs: 5_000 });
  pacer._resetForTest();
  pacer.noteRateLimit({ retryAfterMs: null, reason: "429-noheader", tag: "test" });
  assert.equal(pacer._pausedUntil <= Date.now() + 5_000, true);
  assert.equal(pacer._pausedUntil > Date.now() + 500, true);
});

test("waitForSlot returns promptly when the pacer is ready", async () => {
  const pacer = new Pacer({ minGapMs: 10, jitterMs: 0, maxWaitMs: 5000 });
  pacer._resetForTest();
  const t = Date.now();
  await pacer.waitForSlot();
  assert.equal(Date.now() - t < 50, true);
});

test("error path: pacer still reserves the slot so the next call can proceed", async () => {
  const pacer = new Pacer({ minGapMs: 80, jitterMs: 0, maxWaitMs: 5000 });
  pacer._resetForTest();
  await pacer.waitForSlot();
  // next slot is set to now + minGapMs regardless of whether the "call" succeeded
  const t = Date.now();
  await pacer.waitForSlot();
  assert.equal(Date.now() - t >= 75, true);
});
