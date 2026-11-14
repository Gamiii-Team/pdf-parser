// src/providers/modalVllm.js
// Modal-hosted vLLM OpenAI-compatible endpoint — optional, self-hosted.
// Used only for the `modal` backend; Groq is the default.
// Auth: Bearer token, which must equal the `--api-key` passed to vLLM.
// Uses plain fetch — no extra dependency.

import { withRetry, httpErrorFromResponse } from "../util/retry.js";
import { config } from "../config.js";

export function makeModalVllmAdapter() {
  const { modalEndpointUrl, modalApiToken, modalModel } = config;
  if (!modalEndpointUrl) throw new Error("VLLM_ENDPOINT_URL is not set");
  if (!modalApiToken) throw new Error("VLLM_API_TOKEN is not set");

  return {
    name: "modal-vllm",
    model: modalModel,
    async complete(messages, { maxTokens = 8192, temperature = 0.1, responseFormat = "json_object" } = {}) {
      return withRetry(
        async () => {
          const resp = await fetch(`${modalEndpointUrl}/v1/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${modalApiToken}`,
            },
            body: JSON.stringify({
              model: modalModel,
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
        { retries: config.httpRetries, label: "modal-vllm" },
      );
    },
  };
}
