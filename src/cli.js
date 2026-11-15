#!/usr/bin/env node
// src/cli.js
// CLI: node src/cli.js <file> [options]
//   <file>                PDF, scanned PDF, or image (png/jpg/tiff/webp/bmp) — wrapped as a 1-page PDF
//   --subject "..."       document subject (skips LLM subject detection)
//   --model groq|modal    VLM backend (default: $VLM_BACKEND or "groq")
//   --no-figure-pass      skip VLM figure analysis (offline mode; charts stay type:"chart" with null content)
//   --no-subject-detect   skip LLM subject detection (subject becomes "unknown" unless --subject given)
//   --force-vlm           route every page through the VLM path, even born-digital pages
//   --out <dir>           output directory (default: out/cli/<generated-name>/)
//   --pretty              print the manifest to stdout as well

import path from "node:path";
import fs from "node:fs";

import { extractDocument } from "./extractDocument.js";
import { createLogger } from "./util/log.js";

function parseArgs(argv) {
  const out = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--subject") out.subject = argv[++i];
    else if (a === "--model") out.modelBackend = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--figure-pass") out.figurePass = true;
    else if (a === "--no-figure-pass") out.figurePass = false;
    else if (a === "--no-subject-detect") out.subjectDetect = false;
    else if (a === "--force-vlm") out.forceVlm = true;
    else if (a === "--pretty") out.pretty = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
    else out.positional.push(a);
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || opts.positional.length === 0) {
    console.log(`Usage: node src/cli.js <file> [options]\n\n  <file>                PDF, scanned PDF, or image (.png/.jpg/.jpeg/.tif/.tiff/.webp/.bmp)\n\nOptions:\n  --subject "..."       Document subject (skips LLM subject detection)\n  --model groq|modal    VLM backend (default: $VLM_BACKEND, fallback groq)\n  --no-figure-pass      Skip VLM figure analysis (charts keep content:null)\n  --no-subject-detect   Skip LLM subject detection\n  --force-vlm           Force every page through the VLM path\n  --out <dir>           Output directory (default: out/cli/<generated-name>/)\n  --pretty              Print the manifest to stdout as well`);
    process.exit(opts.help ? 0 : 1);
  }
  const input = opts.positional[0];
  const logger = createLogger();
  const { manifest, manifestPath, outDir, report } = await extractDocument(input, { ...opts, logger });
  logger.info(`wrote ${manifestPath}`);
  logger.info(`run report: ${outDir}/run-report.json (${report.duration_ms}ms)`);
  if (opts.pretty) console.log(JSON.stringify(manifest, null, 2));
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
