// src/figureAnalyzer/index.js
// Figure-analyzer interface. The rest of the pipeline never cares WHICH
// analyzer produced a figure element — only that it returns
// { figure_type, description, data, needs_review }.

import { createFlorenceAnalyzer } from "./florence.js";
import { createVlmAnalyzer } from "./vlm.js";
import { makeGroqAdapter } from "../providers/groq.js";
import { makeModalVllmAdapter } from "../providers/modalVllm.js";

/**
 * @param {"florence"|"groq"|"modal-vllm"} kind
 */
export function getFigureAnalyzer(kind) {
  switch (kind) {
    case "florence":
      return createFlorenceAnalyzer();
    case "groq":
      return createVlmAnalyzer(makeGroqAdapter());
    case "modal-vllm":
      return createVlmAnalyzer(makeModalVllmAdapter());
    default:
      throw new Error(`Unknown figure analyzer: ${kind} (expected florence|groq|modal-vllm)`);
  }
}
