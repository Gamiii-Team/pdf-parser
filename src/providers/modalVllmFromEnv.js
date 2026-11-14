// src/providers/modalVllmFromEnv.js
// Shared factory for any OpenAI-compatible Modal vLLM endpoint
// (vllm_app.py / full-qwen8b.py / full-qwen27b.py — identical shape).
// The full-modal, full-qwen-8b and full-qwen-27b modes differ ONLY in
// base URL + auth + model id.

import { withRetry, httpErrorFromResponse } from "../util/retry.js";

/**
 * @param {{ baseUrl: string, apiKey: string, model: string, name: string, retries?: number }} cfg
 */
export function makeVllmAdapter(cfg) {
  const { baseUrl, apiKey, model, name } = cfg;
  const url = String(baseUrl ?? "").replace(/\/+$/, "");
  if (!url) throw new Error(`${name}: base URL is not set`);
  if (!apiKey) throw new Error(`${name}: API key is not set`);

  return {
    name,
    model,
    async complete(messages, { maxTokens = 8192, temperature = 0.1, responseFormat = "json_object" } = {}) {
      return withRetry(
        async () => {
          const resp = await fetch(`${url}/v1/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model,
              messages,
              temperature,
              top_p: 1,
              stream: false,
              max_tokens: maxTokens,
              response_format: responseFormat ? { type: responseFormat } : undefined,
            }),
          });
          if (!resp.ok) {
            const snippet = (await resp.text().catch(() => "")).slice(0, 300);
            throw await httpErrorFromResponse(resp, snippet);
          }
          const payload = await resp.json();
          const choice = payload?.choices?.[0];
          return {
            text: choice?.message?.content ?? "",
            finishReason: choice?.finish_reason ?? "unknown",
            usage: payload?.usage
              ? { input: payload.usage.prompt_tokens ?? 0, output: payload.usage.completion_tokens ?? 0 }
              : { input: 0, output: 0 },
          };
        },
        { retries: cfg.retries ?? 6, label: name },
      );
    },
  };
}
