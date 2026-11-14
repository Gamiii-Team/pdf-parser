// tests/providers.test.js — the shared vLLM adapter factory used by
// full-modal / full-qwen-8b / full-qwen-27b — they must ship isomorphic
// OpenAI-compatible requests (only the model id changes).

import { test } from "node:test";
import assert from "node:assert/strict";

import { makeVllmAdapter } from "../src/providers/modalVllmFromEnv.js";

const BASE = "https://example.modal.run/";
const KEY = "test-secret";

function capture() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      json: async () => ({ model: JSON.parse(init.body).model, choices: [{ message: { content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4 } }),
    };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test("makeVllmAdapter honors trailing slash, sets model, posts Bearer auth", async () => {
  const { calls, restore } = capture();
  try {
    const adapter = makeVllmAdapter({ baseUrl: BASE, apiKey: KEY, model: "some/model", name: "t", retries: 0 });
    assert.equal(adapter.model, "some/model");
    assert.equal(adapter.name, "t");
    const out = await adapter.complete([{ role: "user", content: "hi" }]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://example.modal.run/v1/chat/completions");
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.model, "some/model");
    assert.equal(body.stream, false);
    assert.equal(calls[0].init.headers.Authorization, "Bearer test-secret");
    assert.equal(out.finishReason, "stop");
    assert.deepEqual(out.usage, { input: 10, output: 4 });
  } finally {
    restore();
  }
});

test("the three adapters all emit the same HTTP shape — only model differs", async () => {
  const { calls, restore } = capture();
  try {
    const modelA = makeVllmAdapter({ baseUrl: "https://a.example.com/", apiKey: KEY, model: "model-a", name: "a", retries: 0 });
    const modelB = makeVllmAdapter({ baseUrl: "https://b.example.com/", apiKey: KEY, model: "model-b", name: "b", retries: 0 });
    const modelC = makeVllmAdapter({ baseUrl: "https://c.example.com/", apiKey: KEY, model: "model-c", name: "c", retries: 0 });
    await Promise.all([modelA.complete([{ role: "user", content: "x" }]), modelB.complete([{ role: "user", content: "x" }]), modelC.complete([{ role: "user", content: "x" }])]);
    const byUrl = Object.fromEntries(calls.map(({ url, init }) => [url, init]));
    assert.deepEqual(Object.keys(byUrl).sort(), [
      "https://a.example.com/v1/chat/completions",
      "https://b.example.com/v1/chat/completions",
      "https://c.example.com/v1/chat/completions",
    ]);
    for (const u of Object.keys(byUrl)) {
      assert.equal(byUrl[u].headers.Authorization, `Bearer ${KEY}`);
    }
    assert.equal(JSON.parse(byUrl["https://a.example.com/v1/chat/completions"].body).model, "model-a");
    assert.equal(JSON.parse(byUrl["https://b.example.com/v1/chat/completions"].body).model, "model-b");
    assert.equal(JSON.parse(byUrl["https://c.example.com/v1/chat/completions"].body).model, "model-c");
  } finally {
    restore();
  }
});
