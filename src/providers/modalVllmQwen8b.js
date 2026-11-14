// src/providers/modalVllmQwen8b.js
// Provider adapter for the full-qwen-8b Modal app (modal/full-qwen8b.py):
// OpenAI-compatible endpoint for Qwen/Qwen3-VL-8B-Instruct-FP8.
// Same HTTP contract as full-modal, but different env vars.

import { makeVllmAdapter } from "./modalVllmFromEnv.js";
import { config } from "../config.js";

export function makeModalVllmQwen8bAdapter() {
  const { endpointUrl, apiSecret, model } = config.modalQwen8b;
  if (!endpointUrl) throw new Error("MODAL_FULL_QWEN_8B_URL is not set");
  if (!apiSecret) throw new Error("MODAL_API_SECRET is not set (must match the vLLM app's --api-key)");

  return makeVllmAdapter({
    baseUrl: endpointUrl,
    apiKey: apiSecret,
    model,
    name: "qwen-vl-8b",
    retries: config.httpRetries,
  });
}
