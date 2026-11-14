// src/providers/groq.js
// Groq API adapter (groq-sdk). For vision page prompts and figure prompts.
// Default model: qwen/qwen3.8-27b (per user preference).

import Groq from "groq-sdk";
import { withRetry, httpErrorFromResponse } from "../util/retry.js";
import { config } from "../config.js";

const GROQ_MAX_IMAGES_PER_REQUEST = 3;
const GROQ_MAX_REQUEST_BYTES = 20 * 1024 * 1024;

export function makeGroqAdapter() {
  const { groqApiKey, groqModel } = config;
  if (!groqApiKey) throw new Error("GROQ_API_KEY is not set");

  const client = new Groq({ apiKey: groqApiKey });

  async function call(messages, { maxTokens = 8192, temperature = 0.1, withReasoningEffort } = {}) {
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
    return client.chat.completions.create(body);
  }

  return {
    name: "groq",
    model: groqModel,
    async complete(messages, { maxTokens = 8192, temperature = 0.1 } = {}) {
      return withRetry(
        async () => {
          // Strip images past the per-request cap
          const trimmed = trimImages(messages);
          let resp;
          try {
            resp = await call(trimmed, { maxTokens, temperature, withReasoningEffort: true });
          } catch (err) {
            const msg = String(err?.message ?? err);
            if (/reasoning_effort/i.test(msg)) {
              resp = await call(trimmed, { maxTokens, temperature, withReasoningEffort: false });
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
