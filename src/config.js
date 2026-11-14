// src/config.js
// All configuration flows through environment variables (with the documented
// defaults). Nothing secret is hardcoded. Copy .env.example to .env to run.

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");

// Load .env without external deps: parse KEY=value lines, ignore comments/blank lines.
// Values already present in the real environment win.
(function loadDotEnv() {
  try {
    const envPath = path.join(REPO_ROOT, ".env");
    const text = fs.readFileSync(envPath, "utf8");
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
  } catch {
    // .env is optional; real environment variables may be used instead.
  }
})();

function int(name, fallback) {
  const v = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) ? v : fallback;
}

function float(name, fallback) {
  const v = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(v) ? v : fallback;
}

function str(name, fallback = "") {
  const v = process.env[name];
  return v == null ? fallback : v.trim();
}

export const PROMPT_VERSION = "page-1.0.0"; // bump when prompts change (affects cache keys)

export const config = {
  // --- Inference endpoints ---
  groq: {
    apiKey: str("GROQ_API_KEY"),
    model: str("GROQ_MODEL", "qwen/qwen3.8-27b"),
    // Documented Groq limits for qwen/qwen3.8-27b (see console.groq.com/docs/vision):
    maxImagesPerRequest: 3,
    maxRequestBytes: 20 * 1024 * 1024,
    imageTokens: 2048,
  },
  modal: {
    // OpenAI-compatible base URL of the vLLM app, e.g. https://<you>--florence2-vllm.modal.run
    endpointUrl: str("MODAL_ENDPOINT_URL").replace(/\/+$/, ""),
    apiSecret: str("MODAL_API_SECRET"), // same value as the `florence-api` Modal secret
    model: str("VLLM_MODEL", "Qwen/Qwen3-VL-4B-Instruct"),
  },
  modalQwen8b: {
    // full-qwen-8b: self-hosted Qwen3-VL-8B-Instruct-FP8 (~9 GB, T4/A10G)
    endpointUrl: str("MODAL_FULL_QWEN_8B_URL").replace(/\/+$/, ""),
    apiSecret: str("MODAL_API_SECRET"),
    model: str("MODAL_FULL_QWEN_8B_MODEL", "Qwen/Qwen3-VL-8B-Instruct-FP8"),
  },
  modalQwen27b: {
    // full-qwen-27b: self-hosted Qwen3.8-27B-Instruct-FP8 (~30 GB, A100-40GB)
    endpointUrl: str("MODAL_FULL_QWEN_27B_URL").replace(/\/+$/, ""),
    apiSecret: str("MODAL_API_SECRET"),
    model: str("MODAL_FULL_QWEN_27B_MODEL", "Qwen/Qwen3.8-27B-Instruct-FP8"),
  },
  florence: {
    // Existing apps (see README): page-image detection and whole-PDF extraction.
    url: str("MODAL_FLORENCE_URL").replace(/\/+$/, ""),
    pdfUrl: str("MODAL_PDF_EXTRACT_URL").replace(/\/+$/, ""),
    apiSecret: str("MODAL_API_SECRET"),
    visionModel: str("VISION_MODEL", "florence-2-large"),
  },

  // --- Rendering ---
  dpi: int("DPI", 170),

  // --- Chunking ---
  chunkTargetTokens: int("CHUNK_TARGET_TOKENS", 500),
  chunkMaxTokens: int("CHUNK_MAX_TOKENS", 800),
  chunkOverlapTokens: int("CHUNK_OVERLAP_TOKENS", 0),
  chunkMinTokens: int("CHUNK_MIN_TOKENS", 120),

  // --- Concurrency / retries ---
  concurrency: int("CONCURRENCY", 4),
  retries: int("MODEL_RETRIES", 3), // attempts for a single page before falling back to needs_review
  httpRetries: int("HTTP_RETRIES", 6), // network/429 backoff retries per call

  // --- Output / cost ---
  outDir: str("OUTPUT_DIR", path.join(REPO_ROOT, "out")),
  cacheDir: str("CACHE_DIR", path.join(REPO_ROOT, ".cache", "extractions")),
  pricePerMInputToken: float("PRICE_PER_M_INPUT_TOKEN", 0),
  pricePerMOutputToken: float("PRICE_PER_M_OUTPUT_TOKEN", 0),

  // --- Modal (vLLM) runtime knobs (used by modal/vllm_app.py via env) ---
  gpu: str("VLLM_GPU", "T4"),
  scaledownWindow: int("VLLM_SCALEDOWN_WINDOW", 300),
};

/** Human-readable list of missing required config for a given mode. */
export function missingConfigForMode(mode) {
  const missing = [];
  if (mode === "full-groq" && !config.groq.apiKey) missing.push("GROQ_API_KEY");
  if (mode === "full-modal") {
    if (!config.modal.endpointUrl) missing.push("MODAL_ENDPOINT_URL");
    if (!config.modal.apiSecret) missing.push("MODAL_API_SECRET");
  }
  if (mode === "full-qwen-8b") {
    if (!config.modalQwen8b.endpointUrl) missing.push("MODAL_FULL_QWEN_8B_URL");
    if (!config.modalQwen8b.apiSecret) missing.push("MODAL_API_SECRET");
  }
  if (mode === "full-qwen-27b") {
    if (!config.modalQwen27b.endpointUrl) missing.push("MODAL_FULL_QWEN_27B_URL");
    if (!config.modalQwen27b.apiSecret) missing.push("MODAL_API_SECRET");
  }
  if (mode === "hybrid-florence" || mode === "full-florence") {
    if (!config.florence.pdfUrl && !config.florence.url) {
      missing.push("MODAL_PDF_EXTRACT_URL (or MODAL_FLORENCE_URL)");
    }
    if (!config.florence.apiSecret) missing.push("MODAL_API_SECRET");
  }
  return missing;
}

/** One-paragraph pointer on how to fix the missing config for a mode. */
export function configHintForMode(mode) {
  switch (mode) {
    case "full-modal":
      return (
        "The vLLM app has never been deployed to your Modal workspace. Deploy it, then copy the URL\n"
        + "the deploy prints into the repo-root .env:\n"
        + "    python -m modal deploy modal/vllm_app.py\n"
        + "    MODAL_ENDPOINT_URL=https://<you>--florence2-vllm-run.modal.run\n"
        + "Full instructions: README.md → \"Deploying to Modal\"."
      );
    case "full-qwen-8b":
      return (
        "The full-qwen-8b app has never been deployed to your Modal workspace. Deploy it, then copy\n"
        + "the URL into the repo-root .env:\n"
        + "    python -m modal deploy modal/full-qwen8b.py\n"
        + "    MODAL_FULL_QWEN_8B_URL=https://<you>--florence2-qwenvl-8b-server.us-east.modal.direct\n"
        + "Requires a T4-class GPU on your Modal plan; check `python -m modal container list --json`."
      );
    case "full-qwen-27b":
      return (
        "The full-qwen-27b app has never been deployed to your Modal workspace. Deploy it, then copy\n"
        + "the URL into the repo-root .env:\n"
        + "    python -m modal deploy modal/full-qwen27b.py\n"
        + "    MODAL_FULL_QWEN_27B_URL=https://<you>--florence2-qwenvl-27b-server.us-east.modal.direct\n"
        + "Requires an A100-40GB on your Modal plan. See README → \"Deploying to Modal\"."
      );
    case "full-groq":
      return "Set GROQ_API_KEY in the repo-root .env (console.groq.com/keys).";
    case "hybrid-florence":
    case "full-florence":
      return "Deploy the Florence apps with `bash scripts/setup_modal.sh`, or set MODAL_PDF_EXTRACT_URL / MODAL_FLORENCE_URL in the repo-root .env.";
    default:
      return "See .env.example and README.md.";
  }
}
