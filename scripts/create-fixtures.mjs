#!/usr/bin/env node
// scripts/create-fixtures.mjs
// Synthesizes two extra fixtures from the born-digital test.pdf:
//   fixtures/scanned.pdf  — rasterized pages re-wrapped as a scanned (image-only) PDF
//   fixtures/page-one.png — page 1 as a standalone image (image-input fixture)
// Run: node scripts/create-fixtures.mjs

import { spawnWorker } from "../src/pymupdf/run.js";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const SRC = path.join(REPO, "test.pdf");
const OUT = path.join(REPO, "fixtures");

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = path.join(os.tmpdir(), `fixgen-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(tmp, { recursive: true });

  // Render both pages (JPEG to keep the fixture small)
  const p1 = path.join(tmp, "page-1.jpg");
  const p2 = path.join(tmp, "page-2.jpg");
  await spawnWorker(["render", SRC, "1", "100", p1]);
  await spawnWorker(["render", SRC, "2", "100", p2]);

  // Scanned PDF: wrap the renders as full-page images (no text layer)
  const scanned = path.join(OUT, "scanned.pdf");
  await spawnWorker(["images-to-pdf", scanned, p1, p2]);

  // Single-image fixture: just page 1
  const imageOut = path.join(OUT, "page-one.png");
  fs.copyFileSync(p1, imageOut);

  // fixtures/README.md for future maintainers
  fs.writeFileSync(path.join(OUT, "README.md"),
`# Fixtures

| File | Kind | Origin |
|---|---|---|
| \`test.pdf\` | born-digital PDF | committed in repo root |
| \`scanned.pdf\` | image-only (scanned-style) PDF | rasterized from \`test.pdf\` at 150 dpi |
| \`page-one.png\` | image input | rasterized page 1 of \`test.pdf\` |

Regenerate with: \`node scripts/create-fixtures.mjs\`
`);

  console.log("fixtures written to", OUT);
}

main().catch((err) => { console.error(err); process.exit(1); });
