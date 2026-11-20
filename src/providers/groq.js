// src/providers/groq.js
// Groq API adapter (groq-sdk). For vision page prompts and figure prompts.
// Default model: qwen/qwen3.8-27b (per user preference).

import Groq from "groq-sdk";
import { withRetry } from "../util/retry.js";
import { config } from "../config.js";
import { pacer } from "../util/pacer.js";

const GROQ_MAX_IMAGES_PER_REQUEST = 3;
const GROQ_MAX_REQUEST_BYTES = 20 * 1024 * 1024;

function is429(err) {
  return err?.status === 429 || err?.statusCode === 429 || err?.code === "rate_limit_exceeded" || /HTTP\s*429/i.test(String(err?.message ?? ""));
}

/** Parse Retry-After into milliseconds (supports delta-seconds and HTTP-date). */
function retryAfterMsFromHeaders(headers) {
  if (!headers?.get) return null;
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const ts = Date.parse(raw);
  if (Number.isFinite(ts)) return Math.max(0, ts - Date.now());
  return null;
}

export function makeGroqAdapter({ client: injectedClient } = {}) {
  const { groqApiKey, groqModel } = config;
  if (!groqApiKey) throw new Error("GROQ_API_KEY is not set");

  const client = injectedClient ?? new Groq({ apiKey: groqApiKey });

  // On a 429, retry once at the pacer cadence (VLM_429_MIN_GAP_MS, default 400 ms,
  // same scale as the inter-request gap) without pausing every worker. Only if it
  // keeps failing (or the server sent Retry-After) do we fall through to the pacer's
  // global cool-down + withRetry's exponential backoff.
  const RATE_LIMIT_MIN_GAP_MS = config.vlm429MinGapMs ?? 400;
  const RATE_LIMIT_MAX_ATTEMPTS = Math.max(0, config.vlm429MaxAttempts ?? 1);

  async function callOnce(messages, opts, timeoutMs) {
    const trimmed = trimImages(messages);
    const resp = await client.chat.completions.create(
      { ...buildBody(trimmed, opts), model: groqModel },
      timeoutMs ? { timeout: timeoutMs } : undefined,
    );
    return resp;
  }

  return {
    name: "groq",
    model: groqModel,
    async complete(messages, { maxTokens = 8192, temperature = 0.1, timeout } = {}) {
      // Pacer — every VLM request passes through the shared choke point.
      await pacer.waitForSlot();
      const timeoutMs = timeout ?? config.vlmTimeoutMs ?? 90000;
      let rateLimitAttempts = 0;
      return withRetry(
        async () => {
          try {
            const resp = await callOnce(messages, { maxTokens, temperature, withReasoningEffort: true }, timeoutMs);
            return toResult(resp);
          } catch (err) {
            if (is429(err)) {
              rateLimitAttempts += 1;
              const retryAfterMs = retryAfterMsFromHeaders(err?.headers) ?? err?.retryAfterMs ?? null;
              if (retryAfterMs) err.retryAfterMs = retryAfterMs;
              if (rateLimitAttempts <= RATE_LIMIT_MAX_ATTEMPTS && !retryAfterMs) {
                // Gentle first retry at the pacer cadence (~400 ms) — the server
                // asked for a slowdown, not a stop, so don't pause every worker.
                const gap = Math.max(RATE_LIMIT_MIN_GAP_MS, pacer.msUntilNextStart());
                await sleep(gap);
                await pacer.waitForSlot();
                const resp = await callOnce(messages, { maxTokens, temperature, withReasoningEffort: true }, timeoutMs);
                return toResult(resp);
              }
              // Retry-After present, or gentle retries exhausted: global cool-down,
              // then let withRetry's exponential backoff take over.
              pacer.noteRateLimit({ retryAfterMs, reason: "429", tag: "groq" });
              throw err;
            }
            if (/reasoning_effort/i.test(String(err?.message ?? err))) {
              const resp = await callOnce(messages, { maxTokens, temperature, withReasoningEffort: false }, timeoutMs);
              return toResult(resp);
            }
            throw err;
          }
        },
        { retries: config.httpRetries ?? 6, label: "groq" },
      );
    },
  };
}

function buildBody(trimmed, { maxTokens, temperature, withReasoningEffort }) {
  const body = {
    model: "", // filled in by caller
    messages: trimmed,
    max_completion_tokens: maxTokens,
    stream: false,
    response_format: { type: "json_object" },
    temperature,
    top_p: 1,
  };
  if (withReasoningEffort) body.reasoning_effort = "low";
  return body;
}

function toResult(resp) {
  const choice = resp?.choices?.[0];
  return {
    text: choice?.message?.content ?? "",
    finishReason: choice?.finish_reason ?? "unknown",
    usage: resp?.usage
      ? { input: resp.usage.prompt_tokens ?? 0, output: resp.usage.completion_tokens ?? 0 }
      : { input: 0, output: 0 },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimImages(messages) {
  // Count images in all message content arrays; drop extras with a warning-style swap
  let images = 0;
  return messages.map((m) => {
    if (Array.isArray(m.content)) {
      const kept = [];
      for (const part of m.content) {
        if (part?.type === "image_url") {
          if (images < GROQ_MAX_IMAGES_PER_REQUEST) { images += 1; kept.push(part); continue; }
          // drop extra images
          continue;
        }
        kept.push(part);
      }
      return { ...m, content: kept };
    }
    return m;
  });
}
