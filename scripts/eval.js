// scripts/eval.js — side-by-side evaluation of the extraction modes on a folder of samples.
//
//   node scripts/eval.js [samplesDir]
//
// For every .pdf/.png/.jpg/.jpeg/.webp in the samples directory, runs each
// available mode (skips a mode when its config is missing) and prints a compact
// comparison: elements, chunks, needs_review counts, completeness, time, tokens,
// est. cost. Writes eval-report.json next to the samples.

import fs from "node:fs";
import path from "node:path";
import { extractDocument } from "../src/extractDocument.js";
import { createLogger } from "../src/util/log.js";
import { missingConfigForMode } from "../src/config.js";

const MODES = ["hybrid-florence", "full-florence", "full-groq", "full-modal", "full-qwen-8b", "full-qwen-27b"];

async function main() {
  const samplesDir = path.resolve(process.argv[2] ?? "samples");
  if (!fs.existsSync(samplesDir)) {
    console.log(`No samples directory at ${samplesDir}. Create it and add sample documents (pdf/png/jpg/webp), then re-run.`);
    return 0;
  }
  const files = fs.readdirSync(samplesDir)
    .filter((f) => /\.(pdf|png|jpe?g|webp)$/i.test(f))
    .sort();
  if (files.length === 0) {
    console.log(`No sample documents in ${samplesDir}.`);
    return 0;
  }

  const results = [];
  for (const file of files) {
    const input = path.join(samplesDir, file);
    for (const mode of MODES) {
      const missing = missingConfigForMode(mode);
      if (missing.length) {
        console.log(`⏭️  ${file} [${mode}] skipped — missing ${missing.join(", ")}`);
        results.push({ file, mode, status: "skipped", missing });
        continue;
      }
      process.stdout.write(`▶️  ${file} [${mode}]… `);
      const t0 = Date.now();
      try {
        const out = path.join(samplesDir, ".eval", file.replace(/\.[^.]+$/, ""), mode, "manifest.json");
        const { report } = await extractDocument(input, {
          mode,
          out,
          logger: createLogger({ silent: true }),
        });
        const ms = Date.now() - t0;
        console.log(`ok (${(ms / 1000).toFixed(1)}s)`);
        results.push({
          file, mode, status: "ok", ms,
          elements: report.elements_total,
          elements_by_type: report.elements,
          chunks: report.chunk_stats.chunks,
          oversized_chunks: report.chunk_stats.oversized_chunks,
          needs_review_chunks: report.chunk_stats.needs_review_chunks,
          completeness_pass: report.chunk_stats.completeness.pass,
          tokens_in: report.totals.tokens_in,
          tokens_out: report.totals.tokens_out,
          est_cost_usd: report.totals.est_cost_usd,
          warnings: report.warnings,
        });
      } catch (err) {
        console.log(`FAILED — ${err.message}`);
        results.push({ file, mode, status: "failed", error: err.message, ms: Date.now() - t0 });
      }
    }
  }

  console.log("\n=== EVAL SUMMARY ===");
  const header = ["file", "mode", "status", "elements", "chunks", "needs_review", "complete", "tokens_in", "tokens_out", "est $"];
  console.log(header.join("\t"));
  for (const r of results) {
    if (r.status !== "ok") {
      console.log([r.file, r.mode, r.status, "-", "-", "-", "-", "-", "-", "-"].join("\t"));
      continue;
    }
    console.log([r.file, r.mode, "ok", r.elements, r.chunks, r.needs_review_chunks, r.completeness_pass ? "PASS" : "FAIL", r.tokens_in, r.tokens_out, r.est_cost_usd].join("\t"));
  }

  const reportPath = path.join(samplesDir, "eval-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
  console.log(`\nEval report: ${reportPath}`);
  const failed = results.filter((r) => r.status === "failed");
  return failed.length ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error("❌", err);
  process.exit(1);
});
