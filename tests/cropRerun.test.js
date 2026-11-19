// tests/cropRerun.test.js — crop pipeline: PUT bbox, preview endpoint, re-run with crop.
// Seeds a real vlm job via runPptxVlmDeck (stubbed provider), then exercises the spawned HTTP server.
// Docker-gated; no Groq calls.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));

const dockerOk = () => {
  try { execFileSync("docker", ["image", "inspect", "pdf-parser-converter:latest", "--format", "{{.Id}}"], { stdio: "pipe" }); return true; } catch { return false; }
};

const stubSlide = (n) => JSON.stringify({
  slide: n, title: `Slide ${n}`, subtitle: null,
  text_blocks: [{ text: `Body of slide ${n}`, role: "body", level: 0 }],
  tables: [], figures: [{
    type: "chart", title: "Rev", description: "bar chart",
    data: { labels: ["a", "b"], series: [] },
    visible_text: ["Rev", "a", "b"],
    bbox: [0.1, 0.1, 0.9, 0.9],
  }],
  speaker_notes: null, confidence: "high", issues: [],
});
const stubProvider = {
  async complete(messages) {
    const prompt = messages?.[1]?.content?.find((c) => c.type === "text")?.text ?? "";
    const n = Number(prompt.match(/Slide number: (\d+)/)?.[1] ?? 1);
    return { text: stubSlide(n), finishReason: "stop", usage: { input: 10, output: 5 } };
  },
};

const silent = { info() {}, warn() {}, error() {} };

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}
const waitForServer = async (base, tries = 50) => {
  for (let i = 0; i < tries; i += 1) {
    try { const r = await fetch(base + "/api/status"); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("server did not boot");
};

let tmp, base, server, jobId, jobDir;

before(async () => {
  if (!dockerOk()) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "crop-rerun-"));
  process.env.OUTPUT_DIR = tmp;
  process.env.GROQ_API_KEY = ""; // any accidental call fails fast
  const { runPptxVlmDeck } = await import("../src/pptxVlmRun.js");
  const { result } = await runPptxVlmDeck(path.join(REPO, "fixtures", "sample.pptx"), {
    provider: stubProvider, logger: silent,
  });
  jobId = result.jobId;
  jobDir = path.join(tmp, "vlm", jobId);
  // find the real job dir (out/vlm/<id>/vlm/<slug>)
  const mode = fs.readdirSync(path.join(jobDir))[0];
  const model = fs.readdirSync(path.join(jobDir, mode))[0];
  jobDir = path.join(jobDir, mode, model);

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["UI/server.mjs"], {
    cwd: REPO,
    env: { ...process.env, OUTPUT_DIR: tmp, PORT: String(port), GROQ_API_KEY: "" },
    stdio: "ignore",
  });
  await waitForServer(base);
});

after(() => {
  server?.kill("SIGTERM");
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.OUTPUT_DIR;
  delete process.env.GROQ_API_KEY;
});

const api = async (p, opts = {}) => {
  const r = await fetch(base + p, { headers: { "Content-Type": "application/json" }, ...opts });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
};

test("PUT bbox persists; fixture-seeded slide already carries one", async (t) => {
  if (!dockerOk()) { t.skip("converter image not built"); return; }
  const { status, body } = await api(`/api/jobs/${jobId}/slides/1`, {
    method: "PUT",
    body: JSON.stringify({ json: {
      slide: 1, title: "S1", subtitle: null,
      text_blocks: [{ text: "body", role: "body", level: 0 }],
      tables: [], speaker_notes: null,
      figures: [{ type: "chart", title: "Cropped from PUT", description: "bar chart", data: { labels: ["x"], series: [] }, visible_text: [], bbox: [0.2, 0.2, 0.8, 0.8], bbox_source: "reviewer", bbox_locked: true }],
      confidence: "high", issues: [],
    } }),
  });
  assert.equal(status, 200, body?.error);
  assert.equal(body.slide.figures[0].bbox[0], 0.2);
  assert.equal(body.slide.figures[0].bbox_source, "reviewer");
});

test("crop preview returns a PNG for a boxed figure", async (t) => {
  if (!dockerOk()) { t.skip("converter image not built"); return; }
  const r = await fetch(`${base}/api/jobs/${jobId}/slides/1/crop/0`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/png");
  const buf = Buffer.from(await r.arrayBuffer());
  assert.ok(buf.length > 100, "crop should be a non-trivial PNG");
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

test("export strips the crops meta and review-only fields", async (t) => {
  if (!dockerOk()) { t.skip("converter image not built"); return; }
  const r = await fetch(`${base}/api/jobs/${jobId}/export`);
  assert.equal(r.status, 200);
  const body = await r.json();
  for (const s of body.slides) {
    assert.equal("previous" in s, false);
    assert.equal("rerun_count" in s, false);
    assert.equal("reviewed" in s, false);
    for (const f of s.figures ?? []) {
      assert.equal("bbox" in f, false, "bbox must be stripped from export");
      assert.equal("bbox_source" in f, false);
      assert.equal("bbox_locked" in f, false);
    }
  }
});

test("module-level: rerunFigures attaches crops as extra images", async () => {
  const { rerunFigures } = await import("../src/extract/slideVlm.js");
  const { renderFigureCrop } = await import("../src/crop.js");
  // seed a job if not seeded
  let pngPath;
  try { pngPath = path.join(jobDir, "slides", "01.png"); fs.accessSync(pngPath); } catch { return t?.skip?.("converter image not built"); }
  const sourcePdf = path.join(jobDir, "source.pdf");
  fs.accessSync(sourcePdf);
  const cropPath = path.join(tmp, "crop-rerun-test.png");
  await renderFigureCrop(sourcePdf, 1, [0.1, 0.1, 0.9, 0.9], cropPath, { pad: 0, dpi: 150 });
  const captured = [];
  const stub = {
    async complete(messages) {
      captured.push(messages);
      return { text: JSON.stringify({ figures: [], tables: [] }), finishReason: "stop", usage: { input: 10, output: 5 } };
    },
  };
  const currentSlide = {
    slide: 1,
    figures: [{ type: "chart", title: "Rev", description: "bar", data: { labels: [], series: [] }, visible_text: [], bbox: [0.1, 0.1, 0.9, 0.9] }],
    tables: [],
  };
  await rerunFigures({ pngPath, currentSlide, slideNote: "", figureNotes: [], provider: stub, logger: silent, crops: [{ path: cropPath, index: 0 }] });
  const content = captured[0][1].content;
  const imageUrls = content.filter((c) => c.type === "image_url").map((c) => c.image_url.url);
  assert.equal(imageUrls.length, 2, "slides PNG + crop");
  assert.ok(String(content[0].text).includes("crop"), "prompt mentions crops");
});
