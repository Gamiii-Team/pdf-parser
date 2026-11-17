// tests/pptxToPdf.test.js — converter worker: concurrency, timeout/kill, cleanup, friendly errors.
// Host mode is exercised with stub `soffice` binaries so these tests never need LibreOffice.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const HOST_JOB_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-converter-test-jobs-"));

let stubOk, stubSleep;
before(() => {
  stubOk = path.join(HOST_JOB_ROOT, "stub-soffice-ok.sh");
  stubSleep = path.join(HOST_JOB_ROOT, "stub-timeout-soffice.sh");
  fs.writeFileSync(stubOk, `#!/bin/bash
outdir=""
input="\${@: -1}"
echo "start $$ $(date +%s%3N)" >> "$STUB_LOG"
sleep 0.25
for ((i=1; i<=$#; i++)); do if [ "\${!i}" = "--outdir" ]; then j=$((i+1)); outdir="\${!j}"; fi; done
printf '%%PDF-1.4\\n' > "$outdir/input.pdf"
echo "end $$ $(date +%s%3N)" >> "$STUB_LOG"
`);
  fs.writeFileSync(stubSleep, "#!/bin/bash\nsleep 30\n");
  fs.chmodSync(stubOk, 0o755);
  fs.chmodSync(stubSleep, 0o755);
});

after(() => {
  fs.rmSync(HOST_JOB_ROOT, { recursive: true, force: true });
});

let counter = 0;
const MANAGED = ["PPTX_CONVERTER", "PPTX_CONVERTER_IMAGE", "PPTX_SOFFICE_PATH", "PPTX_CONVERT_TIMEOUT_MS", "PPTX_CONVERT_CONCURRENCY", "PPTX_JOB_ROOT", "STUB_LOG"];
function freshModule(env) {
  for (const k of MANAGED) delete process.env[k];
  Object.assign(process.env, env);
  const url = pathToFileURL(path.join(REPO, "src", "input", "pptxToPdf.js")).href + `?t=${++counter}`;
  return import(url);
}

const samplePptx = () => path.join(REPO, "fixtures", "sample.pptx");
const jobRootSnapshot = () => {
  const root = process.env.PPTX_JOB_ROOT ?? path.join(REPO, "data", "convert");
  return fs.existsSync(root) ? fs.readdirSync(root) : [];
};

test("docker mode with a missing image reports a friendly build hint", async () => {
  const mod = await freshModule({
    PPTX_CONVERTER: "docker",
    PPTX_CONVERTER_IMAGE: "definitely/not-an-image:nope-9",
    PPTX_JOB_ROOT: path.join(HOST_JOB_ROOT, "jobs-missing-image"),
  });
  await assert.rejects(
    mod.convertPptxToPdf(samplePptx(), {}),
    (err) => err.code === "PPTX_CONVERT_FAILED" && /docker|converter|build/i.test(err.message),
  );
});

test("unknown PPTX_CONVERTER value is rejected", async () => {
  const mod = await freshModule({ PPTX_CONVERTER: "bogus", PPTX_JOB_ROOT: path.join(HOST_JOB_ROOT, "jobs-bogus") });
  await assert.rejects(mod.convertPptxToPdf(samplePptx(), {}), /unknown PPTX_CONVERTER/);
});

test("host mode success produces a PDF and cleans up the job dir", async () => {
  const jobRoot = path.join(HOST_JOB_ROOT, "jobs-ok");
  const log = path.join(HOST_JOB_ROOT, "stub.log");
  const mod = await freshModule({
    PPTX_CONVERTER: "host",
    PPTX_SOFFICE_PATH: stubOk,
    PPTX_CONVERT_TIMEOUT_MS: "10000",
    PPTX_JOB_ROOT: jobRoot,
    STUB_LOG: log,
  });
  const { pdfPath } = await mod.convertPptxToPdf(samplePptx(), {});
  try {
    assert.ok(fs.existsSync(pdfPath), "converted PDF should exist");
    assert.ok(fs.statSync(pdfPath).size > 0, "converted PDF should be non-empty");
    assert.deepEqual(jobRootSnapshot(), [], "job dir must be removed after conversion");
  } finally {
    fs.rmSync(pdfPath, { force: true });
  }
});

test("timeout kills the whole process group, no orphaned soffice", async () => {
  const jobRoot = path.join(HOST_JOB_ROOT, "jobs-timeout");
  const mod = await freshModule({
    PPTX_CONVERTER: "host",
    PPTX_SOFFICE_PATH: stubSleep,
    PPTX_CONVERT_TIMEOUT_MS: "400",
    PPTX_JOB_ROOT: jobRoot,
  });
  await assert.rejects(mod.convertPptxToPdf(samplePptx(), {}), /timed out/);
  // process group must be dead — no stray stub processes
  const pgrep = () => { try { return execFileSync("pgrep", ["-f", "stub-timeout-soffice"], { encoding: "utf8" }).trim(); } catch { return ""; } };
  for (let i = 0; i < 10 && pgrep(); i++) execFileSync("sleep", ["0.1"]);
  assert.equal(pgrep(), "", "timed-out conversion left an orphaned process");
  assert.deepEqual(jobRootSnapshot(), [], "job dir must be removed after a timeout");
});

test("concurrency limit is honored — 3 jobs, max 2 at a time", async () => {
  const jobRoot = path.join(HOST_JOB_ROOT, "jobs-concurrency");
  const log = path.join(HOST_JOB_ROOT, "concurrency.log");
  fs.writeFileSync(log, "");
  const mod = await freshModule({
    PPTX_CONVERTER: "host",
    PPTX_SOFFICE_PATH: stubOk,
    PPTX_CONVERT_TIMEOUT_MS: "10000",
    PPTX_CONVERT_CONCURRENCY: "2",
    PPTX_JOB_ROOT: jobRoot,
    STUB_LOG: log,
  });
  const results = await Promise.all([
    mod.convertPptxToPdf(samplePptx(), {}),
    mod.convertPptxToPdf(samplePptx(), {}),
    mod.convertPptxToPdf(samplePptx(), {}),
  ]);
  try {
    assert.equal(results.length, 3);
    const events = fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
      .map((l) => { const [kind, pid, ts] = l.split(" "); return { kind, pid: Number(pid), ts: Number(ts) }; });
    events.sort((a, b) => a.ts - b.ts);
    let running = 0, peak = 0;
    for (const e of events) { running += e.kind === "start" ? 1 : -1; peak = Math.max(peak, running); }
    assert.equal(peak, 2, `expected at most 2 concurrent conversions, saw ${peak}`);
  } finally {
    for (const r of results) fs.rmSync(r.pdfPath, { force: true });
  }
});

after(() => {
  for (const k of MANAGED) delete process.env[k];
});
