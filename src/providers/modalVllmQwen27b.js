// src/providers/modalVllmQwen27b.js
// Provider adapter for the full-qwen-27b Modal app (modal/full-qwen27b.py):
// OpenAI-compatible endpoint for Qwen/Qwen3.8-27B-Instruct-FP8 on A100-40GB.
// Same HTTP contract as full-modal, but different env vars.

import { makeVllmAdapter } from "./modalVllmFromEnv.js";
import { config } from "../config.js";

export function makeModalVllmQwen27bAdapter() {
  const { endpointUrl, apiSecret, model } = config.modalQwen27b;
  if (!endpointUrl) throw new Error("MODAL_FULL_QWEN_27B_URL is not set");
  if (!apiSecret) throw new Error("MODAL_API_SECRET is not set (must match the vLLM app's --api-key)");

  return makeVllmAdapter({
    baseUrl: endpointUrl,
    apiKey: apiSecret,
    model,
    name: "qwen-vl-27b",
    retries: config.httpRetries,
  });
}
