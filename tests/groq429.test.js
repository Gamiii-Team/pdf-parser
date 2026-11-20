// tests/groq429.test.js — 429 recovery cadence with an injected Groq client (no network).
// Verifies the first retry happens at the pacer cadence, not the 2s global cooldown.

import { test } from "node:test";
import assert from "node:assert/strict";

// Config is read at module load — set knobs before the dynamic import.
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || "test-key";
process.env.VLM_MIN_GAP_MS = "10";
process.env.VLM_GAP_JITTER_MS = "0";
process.env.VLM_429_MIN_GAP_MS = "50";
process.env.VLM_429_MAX_ATTEMPTS = "1";

const ok = {
  choices: [{ message: { content: JSON.stringify({ ok: true }) }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
};

test("429 → gentle retry at ~400ms cadence (pacer gap), no global pause on first failure", async () => {
  const { makeGroqAdapter } = await import("../src/providers/groq.js");
  let calls = 0;
  const client = {
    chat: { completions: {
      async create() {
        calls += 1;
        if (calls === 1) {
          const e = new Error("rate limited");
          e.status = 429;
          e.headers = { get: () => null };
          throw e;
        }
        return ok;
      },
    } },
  };
  const adapter = makeGroqAdapter({ client });
  const t0 = Date.now();
  const result = await adapter.complete([{ role: "user", content: "hi" }]);
  const elapsed = Date.now() - t0;
  assert.equal(calls, 2, "one 429 then success");
  assert.deepEqual(JSON.parse(result.text), { ok: true });
  // VLM_429_MIN_GAP_MS=50 → first retry waited at least 50ms, well under the 2s cooldown.
  assert.ok(elapsed >= 45, `expected >=50ms gentle gap, got ${elapsed}ms`);
  assert.ok(elapsed < 2000, `expected <2s (no global pause), got ${elapsed}ms`);
});

test("429 escalation: after gentle retries are exhausted the adapter still resolves via withRetry", async () => {
  // VLM_429_MAX_ATTEMPTS=1; make every call 429 until withRetry's own attempt succeeds.
  const { makeGroqAdapter } = await import("../src/providers/groq.js");
  let calls = 0;
  const client = {
    chat: { completions: {
      async create() {
        calls += 1;
        if (calls <= 2) {
          const e = new Error("rate limited");
          e.status = 429;
          e.headers = { get: () => null };
          throw e;
        }
        return ok;
      },
    } },
  };
  const adapter = makeGroqAdapter({ client });
  const result = await adapter.complete([{ role: "user", content: "hi" }]);
  assert.deepEqual(JSON.parse(result.text), { ok: true });
  assert.ok(calls >= 3, "gentle retry then withRetry escalation both used");
});
