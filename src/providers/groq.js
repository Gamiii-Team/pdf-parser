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

export function makeGroqAdapter() {
  const { groqApiKey, groqModel } = config;
  if (!groqApiKey) throw new Error("GROQ_API_KEY is not set");

  const client = new Groq({ apiKey: groqApiKey });

  async function call(messages, { maxTokens = 8192, temperature = 0.1, withReasoningEffort } = {}, timeoutMs) {
    const body = {
      model: groqModel,
      messages,
      max_completion_tokens: maxTokens,
      stream: false,
      response_format: { type: "json_object" },
      temperature,
      top_p: 1,
    };
    if (withReasoningEffort) body.reasoning_effort = "low";
    return client.chat.completions.create(body, timeoutMs ? { timeout: timeoutMs } : undefined);
  }

  return {
    name: "groq",
    model: groqModel,
    async complete(messages, { maxTokens = 8192, temperature = 0.1, timeout } = {}) {
      // Pacer — every VLM request passes through the shared choke point.
      await pacer.waitForSlot();
      const timeoutMs = timeout ?? config.vlmTimeoutMs ?? 90000;
      return withRetry(
        async () => {
          // Strip images past the per-request cap
          const trimmed = trimImages(messages);
          let resp;
          try {
            resp = await call(trimmed, { maxTokens, temperature, withReasoningEffort: true }, timeoutMs);
          } catch (err) {
            const msg = String(err?.message ?? err);
            if (is429(err) || /reasoning_effort/i.test(msg)) {
              if (is429(err)) {
                // Global cool-down — every worker pauses together.
                const retryAfterMs = retryAfterMsFromHeaders(err?.headers) ?? err?.retryAfterMs ?? null;
                pacer.noteRateLimit({ retryAfterMs, reason: "429", tag: "groq" });
                throw err;
              }
              resp = await call(trimmed, { maxTokens, temperature, withReasoningEffort: false }, timeoutMs);
            } else {
              throw err;
            }
          }
          const choice = resp?.choices?.[0];
          return {
            text: choice?.message?.content ?? "",
            finishReason: choice?.finish_reason ?? "unknown",
            usage: resp?.usage
              ? { input: resp.usage.prompt_tokens ?? 0, output: resp.usage.completion_tokens ?? 0 }
              : { input: 0, output: 0 },
          };
        },
        { retries: config.httpRetries ?? 6, label: "groq" },
      );
    },
  };
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
