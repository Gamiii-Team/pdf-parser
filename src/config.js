// src/config.js
// Central config: env loading + parsed constants.
// No secrets are hardcoded; defaults match .env.example.

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");

(function loadDotEnv() {
  try {
    const text = fs.readFileSync(path.join(REPO_ROOT, ".env"), "utf8");
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch { /* optional */ }
})();

function int(name, fallback) {
  const v = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) ? v : fallback;
}
function str(name, fallback = "") {
  const v = process.env[name];
  return v == null ? fallback : v.trim();
}

export const MAX_PAGES = 25;

export const config = {
  // Input guards
  maxPages: MAX_PAGES,
  minCharsForTextLayer: int("MIN_CHARS_TEXT_LAYER", 80),
  imageCoverForceVlm: 0.9,

  // Render knobs
  dpi: int("DPI", 170),
  cropDpi: int("CROP_DPI", 200),

  // Concurrency + retries
  concurrency: int("CONCURRENCY", 4),
  retries: int("MODEL_RETRIES", 3),

  // Model selection
  modelBackend: str("VLM_BACKEND", "groq"), // groq | modal
  // Groq
  groqApiKey: str("GROQ_API_KEY"),
  groqModel: str("GROQ_MODEL", "qwen/qwen3.8-27b"),
  // Modal (vLLM with Qwen3-VL)
  modalEndpointUrl: str("VLLM_ENDPOINT_URL").replace(/\/+$/, ""),
  modalApiToken: str("VLLM_API_TOKEN"),
  modalModel: str("VLLM_MODEL", "Qwen/Qwen3-VL-8B-Instruct-FP8"),

  // Output / cost
  outputDir: str("OUTPUT_DIR", path.join(REPO_ROOT, "out")),
  pricePerMInputToken: Number.parseFloat(process.env.PRICE_PER_M_INPUT_TOKEN ?? "0") || 0,
  pricePerMOutputToken: Number.parseFloat(process.env.PRICE_PER_M_OUTPUT_TOKEN ?? "0") || 0,

  // Figures
  figureMaxDimension: int("FIGURE_MAX_DIM", 1600),
};

/** Human-readable diagnostic of missing required config for a CLI call. */
export function missingFor(args = {}) {
  const missing = [];
  if (!args.modelBackend && !config.modelBackend) missing.push("VLM_BACKEND (or pass --model)");
  const backend = args.modelBackend || config.modelBackend;
  if (backend === "groq" && !config.groqApiKey) missing.push("GROQ_API_KEY");
  if (backend === "modal") {
    if (!config.modalEndpointUrl) missing.push("VLLM_ENDPOINT_URL");
    if (!config.modalApiToken) missing.push("VLLM_API_TOKEN");
  }
  return missing;
}
