// src/cli.js — command-line entry:
//   node src/cli.js <input.pdf|image> --mode <mode> [--out path]
// Modes: hybrid-florence | full-florence | full-groq | full-modal
//        | full-qwen-8b | full-qwen-27b

import path from "node:path";
import { extractDocument } from "./extractDocument.js";
import { createLogger } from "./util/log.js";

function parseArgs(argv) {
  const args = {
    input: null,
    mode: "full-groq",
    out: null,
    dpi: undefined,
    figurePass: false,
    figureAnalyzer: "florence",
    chunkTargetTokens: undefined,
    chunkMaxTokens: undefined,
    chunkMinTokens: undefined,
    chunkOverlapTokens: undefined,
    concurrency: undefined,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--mode": args.mode = next(); break;
      case "--out": args.out = next(); break;
      case "--dpi": args.dpi = Number.parseInt(next(), 10); break;
      case "--chunk-target": args.chunkTargetTokens = Number.parseInt(next(), 10); break;
      case "--chunk-max": args.chunkMaxTokens = Number.parseInt(next(), 10); break;
      case "--chunk-min": args.chunkMinTokens = Number.parseInt(next(), 10); break;
      case "--chunk-overlap": args.chunkOverlapTokens = Number.parseInt(next(), 10); break;
      case "--figure-pass": args.figurePass = true; break;
      case "--figure-analyzer": args.figureAnalyzer = next(); break;
      case "-h": case "--help": args.help = true; break;
      default:
        if (!a.startsWith("--") && !args.input) args.input = a;
        else if (a === "--") continue;
        else throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node src/cli.js <input> --mode <mode> [options]

Input: a PDF (born-digital for hybrid-florence/full-florence; anything for the others),
       or a png/jpg/webp image (full-modal/full-groq/full-qwen-* only).

Modes:
  hybrid-florence   Text/tables via unpdf + figures via Modal Florence-2 (PDF only)
  full-florence     Same Florence engine; yields its own run + manifest (PDF only)
  full-groq         Page images -> Groq API (qwen/qwen3.8-27b by default)
  full-modal        Page images -> Modal-hosted vLLM (OpenAI-compatible)
  full-qwen-8b      Page images -> Modal-hosted Qwen3-VL-8B-Instruct-FP8
  full-qwen-27b     Page images -> Modal-hosted Qwen3.8-27B-Instruct-FP8 (A100-40GB)

Options:
  --out <path>            Manifest path (default: out/<stem>/<mode>/manifest.json)
  --dpi <n>               Render DPI (default: 170; env DPI)
  --chunk-target <n>      Target chunk tokens (default: 500; env CHUNK_TARGET_TOKENS)
  --chunk-max <n>         Hard max chunk tokens (default: 800)
  --chunk-min <n>         Below this, merge chunks with a same-parent neighbor (default: 120)
  --chunk-overlap <n>     Overlap tokens between adjacent text chunks, 0 = off (default: 0)
  --figure-pass           hybrid-florence & full-florence only: run the figure analyzer for structured data
  --figure-analyzer <a>   florence | groq | modal-vllm (default: florence)
  -h, --help              Show this help

Env vars (see .env.example): GROQ_API_KEY, MODAL_ENDPOINT_URL, MODAL_API_SECRET,
MODAL_FULL_QWEN_8B_URL, MODAL_FULL_QWEN_27B_URL,
MODAL_PDF_EXTRACT_URL, MODAL_FLORENCE_URL, VLLM_MODEL, GROQ_MODEL, DPI,
CONCURRENCY, CHUNK_*, CACHE_DIR, OUTPUT_DIR.`);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`❌ ${err.message}\n(--help for usage)`);
    return 2;
  }
  if (args.help) { printHelp(); return 0; }
  if (!args.input) { console.error("❌ Missing input file.\n(--help for usage)"); return 2; }

  const logger = createLogger();
  try {
    const { manifestPath, reportPath, report } = await extractDocument(path.resolve(args.input), {
      mode: args.mode,
      out: args.out ?? undefined,
      dpi: args.dpi,
      figurePass: args.figurePass,
      figureAnalyzer: args.figureAnalyzer,
      chunkTargetTokens: args.chunkTargetTokens,
      chunkMaxTokens: args.chunkMaxTokens,
      chunkMinTokens: args.chunkMinTokens,
      chunkOverlapTokens: args.chunkOverlapTokens,
      logger,
    });
    console.log(`\n✅ Manifest: ${manifestPath}`);
    console.log(`📋 Run report: ${reportPath}`);
    console.log(`   pages=${report.pages} elements=${report.elements_total} chunks=${report.chunk_stats.chunks} needs_review_chunks=${report.chunk_stats.needs_review_chunks}`);
    console.log(`   tokens_in=${report.totals.tokens_in} tokens_out=${report.totals.tokens_out} est_cost=$${report.totals.est_cost_usd}${report.warnings.length ? `\n   ⚠️  ${report.warnings.join("\n   ⚠️  ")}` : ""}`);
    return 0;
  } catch (err) {
    console.error(`❌ ${err.message}`);
    return 1;
  }
}

main().then((code) => process.exit(code)).catch((err) => { console.error("❌", err); process.exit(1); });
