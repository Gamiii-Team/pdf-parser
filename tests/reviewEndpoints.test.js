// tests/reviewEndpoints.test.js — review-screen endpoints through a real HTTP server.
// Seeds a job on disk via the real vlm pipeline (stub provider), boots UI/server.mjs,
// exercises GET/PUT/export/DELETE. No Groq calls; docker-gated like the rest.

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
  slide: n, title: `Slide ${n} headline`, subtitle: null,
  text_blocks: [{ text: `Body of slide ${n}`, role: "body", level: 0 }],
  tables: [], figures: [], speaker_notes: null, confidence: "high", issues: [],
});
const stubProvider = {
  async complete(messages) {
    const prompt = messages?.[1]?.content?.find((c) => c.type === "text")?.text ?? "";
    const n = Number(prompt.match(/Slide number: (\d+)/)?.[1] ?? 1);
    return { text: stubSlide(n), finishReason: "stop", usage: { input: 50, output: 20 } };
  },
};

const silent = { info() {}, warn() {}, error() {} };
let tmp, server, base, jobId;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); });
  s.on("error", reject);
});
const waitForServer = async (url, tries = 50) => {
  for (let i = 0; i < tries; i += 1) {
    try { const r = await fetch(url); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("server did not boot");
};

before(async () => {
  if (!dockerOk()) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-endpoints-"));
  process.env.OUTPUT_DIR = tmp;
  const { runPptxVlmDeck } = await import("../src/pptxVlmRun.js");
  const { result } = await runPptxVlmDeck(path.join(REPO, "fixtures", "sample.pptx"), {
    provider: stubProvider, logger: silent,
  });
  jobId = result.jobId;
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["UI/server.mjs"], {
    cwd: REPO,
    env: { ...process.env, OUTPUT_DIR: tmp, PORT: String(port) },
    stdio: "ignore",
  });
  await waitForServer(`${base}/api/status`);
});

after(() => {
  server?.kill("SIGTERM");
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.OUTPUT_DIR;
});

const get = (p) => fetch(base + p);
const put = (p, body) => fetch(base + p, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const del = (p) => fetch(base + p, { method: "DELETE" });
const api = async (p, opts = {}) => {
  const r = await fetch(base + p, { headers: { "Content-Type": "application/json" }, ...opts });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
};

test("jobs list includes the vlm job", async (t) => {
  if (!dockerOk()) { t.skip("converter image not built"); return; }
  const { body } = await api("/api/jobs");
  const found = body.jobs.find((j) => j.id === jobId);
  assert.ok(found, "vlm job must appear in /api/jobs");
  assert.equal(found.mode, "vlm");
  assert.equal(found.status, "review");
});

test("GET /api/jobs/:id returns result with review flags", async (t) => {
  if (!dockerOk()) { t.skip("converter image not built"); return; }
  const { status, body } = await api(`/api/jobs/${jobId}`);
  assert.equal(status, 200);
  assert.equal(body.job.mode, "vlm");
  assert.equal(body.result.slides.length, 3);
  assert.equal(body.result.slides[0].reviewed, false);
});

test("slide image serves png bytes", async (t) => {
  if (!dockerOk()) { t.skip("converter image not built"); return; }
  const r = await fetch(`${base}/api/jobs/${jobId}/slides/2`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/png");
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), true);
});

test("PUT with schema-invalid figures is rejected with 400", async (t) => {
  if (!dockerOk()) { t.skip("converter image not built"); return; }
  const { status, body } = await api(`/api/jobs/${jobId}/slides/1`, {
    method: "PUT",
    body: JSON.stringify({ figures: [{ type: "chart", description: "", bad: "shape" }], tables: [] }),
  });
  assert.equal(status, 400);
  assert.match(body.error ?? "", /figures/);
});

test("PUT edits figures; Approve marks slide approved and persists", async (t) => {
  if (!dockerOk()) { t.skip("converter image not built"); return; }
  const editedFigure = {
    type: "chart", title: "EDITED BY REVIEWER", description: "edited figure",
    data: { labels: ["x"], series: [] }, visible_text: ["x"], bbox: [0.1, 0.1, 0.9, 0.9],
  };
  const put = await api(`/api/jobs/${jobId}/slides/2`, {
    method: "PUT",
    body: JSON.stringify({ figures: [editedFigure], tables: [] }),
  });
  assert.equal(put.status, 200);
  assert.equal(put.body.slide.figures[0].title, "EDITED BY REVIEWER");
  assert.equal(put.body.slide.reviewed, false, "PUT alone must not mark approved");

  const approve = await api(`/api/jobs/${jobId}/slides/2/approve`, {
    method: "POST",
    body: JSON.stringify({ json: { figures: [editedFigure], tables: [] } }),
  });
  assert.equal(approve.status, 200);
  assert.equal(approve.body.slide.reviewed, true);
  assert.equal(approve.body.slide.title, "Slide 2 headline", "base (title/etc.) must pass through approve unchanged");
  assert.ok(approve.body.main, "approve must rebuild main.json");

  const again = await api(`/api/jobs/${jobId}`);
  assert.equal(again.body.job.statuses["2"], "approved");
});

test("approve with schema-invalid tables is rejected with 400", async (t) => {
  if (!dockerOk()) { t.skip("converter image not built"); return; }
  const { status, body } = await api(`/api/jobs/${jobId}/slides/3/approve`, {
    method: "POST",
    body: JSON.stringify({ json: { figures: [{ type: "chart", description: "d" }], tables: [{ headers: ["a"], rows: [["1", 42]] }] } }),
  });
  assert.equal(status, 400);
  assert.match(body.error ?? "", /tables/);
});

test("reopen on a never-approved slide is rejected with 400", async (t) => {
  if (!dockerOk()) { t.skip("converter image not built"); return; }
  const { status, body } = await api(`/api/jobs/${jobId}/slides/3/reopen`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  assert.equal(status, 400);
  assert.match(body.error ?? "", /not approved/);
});

test("PUT on approved slide is rejected with 409 — reopen required", async (t) => {
  if (!dockerOk()) { t.skip("converter image not built"); return; }
  const fig = { type: "chart", title: "t", description: "d", data: { labels: [], series: [] }, visible_text: [] };
  await api(`/api/jobs/${jobId}/slides/2/approve`, {
    method: "POST",
    body: JSON.stringify({ json: { figures: [fig], tables: [] } }),
  });
  const again1 = await api(`/api/jobs/${jobId}/slides/2`, {
    method: "PUT",
    body: JSON.stringify({ figures: [fig], tables: [] }),
  });
  assert.equal(again1.status, 409);
  const rerun = await api(`/api/jobs/${jobId}/slides/2/rerun`, {
    method: "POST",
    body: JSON.stringify({ slideNote: "", figureNotes: [] }),
  });
  assert.equal(rerun.status, 409);
  const zoom = await api(`/api/jobs/${jobId}/slides/2/zoom`, {
    method: "POST",
    body: JSON.stringify({ figureIndex: 0 }),
  });
  assert.equal(zoom.status, 409);
});

test("approve is idempotent — a repeat call changes nothing and returns ok", async (t) => {
  if (!dockerOk()) { t.skip("converter image not built"); return; }
  const fig = { type: "chart", title: "t", description: "d", data: { labels: [], series: [] }, visible_text: [] };
  const first = await api(`/api/jobs/${jobId}/slides/3/approve`, {
    method: "POST",
    body: JSON.stringify({ json: { figures: [fig], tables: [] } }),
  });
  assert.equal(first.status, 200);
  const second = await api(`/api/jobs/${jobId}/slides/3/approve`, {
    method: "POST",
    body: JSON.stringify({ json: { figures: [], tables: [] } }),
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.alreadyApproved, true);
  assert.equal(second.body.slide.reviewed, true);
});

test("export returns merged main.json; review-only fields stripped", async (t) => {
  if (!dockerOk()) { t.skip("converter image not built"); return; }
  const fig1 = {
    type: "chart", title: "queued unapproved", description: "chart",
    data: { labels: [], series: [] }, visible_text: [],
  };
  // Slide 2 is approved from earlier tests; slide 3 was auto-approved above. Slide 1 is pending.
  const r = await fetch(`${base}/api/jobs/${jobId}/export`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-disposition") ?? "", /attachment/);
  assert.match(r.headers.get("content-type") ?? "", /application\/json/);
  const body = await r.json();
  assert.equal(body.mode, "vlm");
  assert.ok(Array.isArray(body.slides) && body.slides.length === 3, "main.json must carry all slides");
  const s1 = body.slides.find((s) => s.slide === 1);
  const s2 = body.slides.find((s) => s.slide === 2);
  const s3 = body.slides.find((s) => s.slide === 3);
  assert.equal(s2.review_status, undefined, "approved slides carry no marker");
  assert.equal(s3.review_status, undefined, "approved slides carry no marker");
  for (const s of body.slides) {
    assert.equal("reviewed" in s, false, "reviewed stripped from export");
    assert.equal("previous" in s, false);
    assert.equal("rerun_count" in s, false);
    for (const f of s.figures ?? []) {
      assert.equal("excluded" in f, false);
      assert.equal("reviewer_note" in f, false);
      assert.equal("bbox" in f, false);
    }
  }
});

test("DELETE removes the job; subsequent GET is 404", async (t) => {
  if (!dockerOk()) { t.skip("converter image not built"); return; }
  const { status } = await del(`/api/jobs/${jobId}`).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  assert.equal(status, 200);
  const afterGet = await api(`/api/jobs/${jobId}`);
  assert.equal(afterGet.status, 404);
});
