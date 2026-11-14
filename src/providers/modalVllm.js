// src/providers/modalVllm.js
// Provider adapter for the Modal-hosted vLLM OpenAI-compatible endpoint
// (see modal/vllm_app.py). Auth: Bearer token, which vLLM reads from
// `--api-key` (set to MODAL_API_SECRET).

import { makeVllmAdapter } from "./modalVllmFromEnv.js";
import { config } from "../config.js";

export function makeModalVllmAdapter() {
  const { endpointUrl, apiSecret, model } = config.modal;
  if (!endpointUrl) throw new Error("MODAL_ENDPOINT_URL is not set");
  if (!apiSecret) throw new Error("MODAL_API_SECRET is not set (must match the vLLM app's --api-key)");

  const adapter = makeVllmAdapter({
    baseUrl: endpointUrl,
    apiKey: apiSecret,
    model,
    name: "modal-vllm",
  });
  return adapter;
}
