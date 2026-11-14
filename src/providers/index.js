// src/providers/index.js
// Provider selector.

import { config } from "../config.js";
import { makeGroqAdapter } from "./groq.js";
import { makeModalVllmAdapter } from "./modalVllm.js";

export function makeProvider(name) {
  const backend = (name ?? config.modelBackend).toLowerCase();
  if (backend === "groq") return makeGroqAdapter();
  if (backend === "modal") return makeModalVllmAdapter();
  throw new Error(`Unknown backend: ${backend} (expected 'groq' or 'modal')`);
}
