// src/providers/groq.js
// Provider adapter for the Groq API (groq-sdk). Model default:
// qwen/qwen3.8-27b (vision-capable; see console.groq.com/docs/vision).
// Documented limits for this model: <= 3 images per request, <= 20 MB per
// request, 2048 input tokens per image, 131K context window.

import Groq from "groq-sdk";
import { withRetry } from "../util/retry.js";
import { config } from "../config.js";

export function makeGroqAdapter() {
  const { apiKey, model } = config.groq;
  if (!apiKey) throw new Error("GROQ_API_KEY is not set");

  const client = new Groq({ apiKey });

  async function request(messages, { maxTokens, temperature, withReasoningEffort }) {
    const body = {
      model,
      messages,
      temperature,
      top_p: 1,
      max_completion_tokens: maxTokens,
      stream: false,
      response_format: { type: "json_object" },
    };
    if (withReasoningEffort) body.reasoning_effort = "low";
    return client.chat.completions.create(body);
  }

  return {
    name: "groq",
    model,
    async complete(messages, { maxTokens = 8192, temperature = 0.1 } = {}) {
      return withRetry(
        async () => {
          let resp;
          try {
            resp = await request(messages, { maxTokens, temperature, withReasoningEffort: true });
          } catch (err) {
            // If the provider rejects reasoning_effort for this model, retry once without it.
            const msg = String(err?.message ?? err);
            if (/reasoning_effort/i.test(msg)) {
              resp = await request(messages, { maxTokens, temperature, withReasoningEffort: false });
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
        { retries: config.httpRetries, label: "groq" },
      );
    },
  };
}
