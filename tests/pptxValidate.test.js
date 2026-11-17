// tests/pptxValidate.test.js — PPTX package validation before any converter runs.
// Every case here must reject (or accept) WITHOUT spawning LibreOffice, WITHOUT
// extracting anything to disk, and with as little allocation as possible.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { validatePptx, PptxValidationError } from "../src/input/pptxValidate.js";
import { buildZip, validPptxParts, validPptxZip, pngWithSize } from "./helpers/zipBuilder.mjs";

let tmpDir;
before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-validate-test-")); });
after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function writeTmp(name, buf) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, buf);
  return p;
}

function rejectsRule(promise, rule) {
  return assert.rejects(promise, (err) => {
    assert.ok(err instanceof PptxValidationError, `expected PptxValidationError, got ${err?.constructor?.name}: ${err?.message}`);
    assert.equal(err.code, "PPTX_INVALID");
    assert.equal(err.rule, rule, `expected rule ${rule}, got ${err.rule}: ${err.message}`);
    return true;
  });
}

// ───────────────────────── happy paths ─────────────────────────

test("the committed fixture passes: 3 visible slides (1 hidden + 1 empty excluded)", async () => {
  const r = await validatePptx(path.resolve("fixtures/sample.pptx"));
  assert.equal(r.slides, 3);
  assert.equal(r.hidden, 1);
  assert.equal(r.empty, 1);
  assert.equal(r.mediaFiles, 1);
});

test("25 visible slides pass exactly at the cap", async () => {
  const specs = Array.from({ length: 25 }, (_, i) => ({ text: `Slide ${i + 1} content` }));
  specs.push({ text: "Hidden one", hidden: true }, { shapes: false }, { shapes: false }); // not counted
  const p = writeTmp("cap-ok.pptx", validPptxZip(specs));
  const r = await validatePptx(p);
  assert.equal(r.slides, 25);
});

// ───────────────────────── basic rejections ─────────────────────────

test("not a zip at all", async () => {
  const p = writeTmp("not-zip.pptx", Buffer.from("this is definitely not a zip file, trust me"));
  await rejectsRule(validatePptx(p), "magic");
});

test("empty file", async () => {
  const p = writeTmp("empty.pptx", Buffer.alloc(0));
  await rejectsRule(validatePptx(p), "file-type");
});

test("file over the 25 MB cap is rejected before parsing", async () => {
  const p = writeTmp("too-big.pptx", Buffer.alloc(26 * 1024 * 1024, 0x50));
  await rejectsRule(validatePptx(p), "file-size");
});

test("generic zip renamed to .pptx (missing ppt/presentation.xml)", async () => {
  const p = writeTmp("renamed.pptx", buildZip([{ name: "readme.txt", data: "hello" }]));
  await rejectsRule(validatePptx(p), "structure");
});

test("DOCX renamed to .pptx is rejected", async () => {
  const docx = buildZip([
    { name: "[Content_Types].xml", data: "<Types/>" },
    { name: "_rels/.rels", data: "<Relationships/>" },
    { name: "word/document.xml", data: "<w:document/>" },
  ]);
  const p = writeTmp("renamed-docx.pptx", docx);
  await rejectsRule(validatePptx(p), "structure");
});

// ───────────────────────── zip-bomb defenses ─────────────────────────

test("classic high-ratio bomb: declared sizes pass, inflated bytes exceed cap", async () => {
  // 128 MB of zeros compress to ~125 KB. Declared UNCOMPRESSED size is set to
  // 40 KB (passes every declared-size cap), while the real compressed data is
  // unchanged — the streaming pass must count actual bytes and abort.
  const zeros = Buffer.alloc(128 * 1024 * 1024);
  const bomb = buildZip([
    { name: "[Content_Types].xml", data: "x" },
    { name: "_rels/.rels", data: "x" },
    { name: "ppt/presentation.xml", data: "x" },
    { name: "ppt/slides/slide1.xml", data: zeros, declaredUncomp: 40 * 1024 },
  ]);
  process.env.PPTX_MAX_ENTRY_RATIO = "100000000";
  process.env.PPTX_MAX_OVERALL_RATIO = "100000000";
  process.env.PPTX_MAX_ENTRY_UNCOMPRESSED = String(50 * 1024 * 1024);
  process.env.PPTX_MAX_TOTAL_UNCOMPRESSED = String(10 * 1024 * 1024);
  try {
    const p = writeTmp("bomb.pptx", bomb);
    await rejectsRule(validatePptx(p), "bomb");
  } finally {
    delete process.env.PPTX_MAX_ENTRY_RATIO;
    delete process.env.PPTX_MAX_OVERALL_RATIO;
    delete process.env.PPTX_MAX_ENTRY_UNCOMPRESSED;
    delete process.env.PPTX_MAX_TOTAL_UNCOMPRESSED;
  }
});

test("declared uncompressed size alone trips the cap without inflating", async () => {
  const specs = [{ text: "x" }];
  const parts = validPptxParts(specs);
  parts[0] = { ...parts[0], declaredUncomp: 100 * 1024 * 1024 }; // one entry claims 100 MB
  const p = writeTmp("declared-bomb.pptx", buildZip(parts));
  await rejectsRule(validatePptx(p), "entry-size");
});

test("overall declared ratio over the cap is rejected", async () => {
  const zeros = Buffer.alloc(30 * 1024 * 1024);
  const z = buildZip([
    { name: "[Content_Types].xml", data: "x" },
    { name: "_rels/.rels", data: "x" },
    { name: "ppt/presentation.xml", data: "x" },
    { name: "ppt/slides/slide1.xml", data: zeros },
  ]);
  process.env.PPTX_MAX_ENTRY_RATIO = "100000000"; // isolate the overall-ratio rule
  try {
    const p = writeTmp("overall-ratio.pptx", z);
    await rejectsRule(validatePptx(p), "ratio");
  } finally {
    delete process.env.PPTX_MAX_ENTRY_RATIO;
  }
});

test("too many entries is rejected before any inflation", async () => {
  const entries = Array.from({ length: 11 }, (_, i) => ({ name: `ppt/media/m${i}.bin`, data: Buffer.from([i]) }));
  process.env.PPTX_MAX_ENTRIES = "10";
  try {
    const p = writeTmp("many-entries.pptx", buildZip(entries));
    await rejectsRule(validatePptx(p), "entries");
  } finally {
    delete process.env.PPTX_MAX_ENTRIES;
  }
});

test("nested archive inside ppt/embeddings is rejected", async () => {
  const p = writeTmp("nested.pptx", validPptxZip([{ text: "hi" }], [{ name: "ppt/embeddings/chart.zip", data: buildZip([{ name: "a.txt", data: "a" }]) }]));
  await rejectsRule(validatePptx(p), "nested-archive");
});

// ─────────────────────── structural attacks ───────────────────────

test("path traversal entry is rejected", async () => {
  const p = writeTmp("traversal.pptx", buildZip([{ name: "ppt/../../evil.xml", data: "boom" }]));
  await rejectsRule(validatePptx(p), "entry-name");
});

test("absolute path entry is rejected", async () => {
  const p = writeTmp("absolute.pptx", buildZip([{ name: "/etc/passwd", data: "boom" }]));
  await rejectsRule(validatePptx(p), "entry-name");
});

test("backslash entry is rejected", async () => {
  const p = writeTmp("backslash.pptx", buildZip([{ name: "ppt\\slides\\slide1.xml", data: "boom" }]));
  await rejectsRule(validatePptx(p), "entry-name");
});

test("duplicate entry name is rejected", async () => {
  const dup = buildZip([
    { name: "[Content_Types].xml", data: "first" },
    { name: "[Content_Types].xml", data: "second" },
  ]);
  const p = writeTmp("duplicate.pptx", dup);
  await rejectsRule(validatePptx(p), "duplicate");
});

test("encrypted entry is rejected", async () => {
  const enc = buildZip([{ name: "[Content_Types].xml", data: "x", flags: 0x0801 }]);
  const p = writeTmp("encrypted.pptx", enc);
  await rejectsRule(validatePptx(p), "encrypted");
});

test("symlink entry (unix mode bits) is rejected", async () => {
  const sym = buildZip([{ name: "ppt/media/link.png", data: "x", externalAttrs: 0xa0000000 }]);
  const p = writeTmp("symlink.pptx", sym);
  await rejectsRule(validatePptx(p), "file-type");
});

test("local/central name mismatch (zip quilting) is rejected", async () => {
  const parts = validPptxParts([{ text: "hi" }]);
  const quilter = parts.find((x) => x.name === "ppt/slides/slide1.xml");
  quilter.centralName = "ppt/slides/slide9.xml"; // central directory claims a different part name
  const p = writeTmp("quilting.pptx", buildZip(parts));
  await rejectsRule(validatePptx(p), "quilting");
});

test("overlapping entries are rejected", async () => {
  // Entry B's local header lies INSIDE entry A's compressed data range.
  const parts = validPptxParts([{ text: "x".repeat(500) }]);
  const buf = buildZip([
    { name: "a.bin", data: Buffer.alloc(4000, 1) },
    { name: "b.bin", data: Buffer.alloc(10, 2), declaredUncomp: 10 },
  ]);
  // craft an overlap by hand: take a.bin's local offset and point b.bin inside its data
  // easier: patch central directory of b.bin to start inside a.bin's data
  const eocdPos = buf.length - 22;
  const cdOffset = buf.readUInt32LE(eocdPos + 16);
  // walk to second central record
  const rec0 = cdOffset;
  const nameLen0 = buf.readUInt16LE(rec0 + 28);
  const rec1 = rec0 + 46 + nameLen0;
  buf.writeUInt32LE(30, rec1 + 42); // b.bin "starts" at offset 30 — inside a.bin's header/data
  const p = writeTmp("overlapping.pptx", buf);
  await assert.rejects(validatePptx(p), (err) => err instanceof PptxValidationError);
});

test("unsupported compression method is rejected", async () => {
  const p = writeTmp("method.pptx", buildZip([{ name: "x.bin", data: "abc", method: 99 }]));
  await rejectsRule(validatePptx(p), "method");
});

// ──────────────────── slides & media limits ─────────────────────

test("26 visible slides exceeds the 25-slide cap", async () => {
  const specs = Array.from({ length: 26 }, (_, i) => ({ text: `Slide ${i + 1}` }));
  const p = writeTmp("too-many-slides.pptx", validPptxZip(specs));
  await rejectsRule(validatePptx(p), "slides");
});

test("hidden and empty slides do not count toward the cap", async () => {
  const specs = [
    ...Array.from({ length: 25 }, (_, i) => ({ text: `Visible ${i + 1}` })),
    ...Array.from({ length: 10 }, () => ({ text: "", hidden: true })),
    ...Array.from({ length: 10 }, () => ({ shapes: false })),
  ];
  const p = writeTmp("hidden-empty.pptx", validPptxZip(specs));
  const r = await validatePptx(p);
  assert.equal(r.slides, 25);
});

test("all-hidden deck is rejected", async () => {
  const specs = [{ text: "secret", hidden: true }, { text: "also hidden", hidden: true }];
  const p = writeTmp("all-hidden.pptx", validPptxZip(specs));
  await rejectsRule(validatePptx(p), "slides");
});

test("too many media files is rejected", async () => {
  const media = Array.from({ length: 3 }, (_, i) => ({ name: `ppt/media/m${i}.png`, data: pngWithSize(4, 4) }));
  process.env.PPTX_MAX_MEDIA_FILES = "2";
  try {
    const p = writeTmp("media-cap.pptx", validPptxZip([{ text: "hi" }], media));
    await rejectsRule(validatePptx(p), "media");
  } finally {
    delete process.env.PPTX_MAX_MEDIA_FILES;
  }
});

test("oversized image dimensions are rejected", async () => {
  const big = { name: "ppt/media/huge.png", data: pngWithSize(20000, 100) };
  const p = writeTmp("big-image.pptx", validPptxZip([{ text: "hi" }], [big]));
  await rejectsRule(validatePptx(p), "image-dimensions");
});

// ───────────────── converter-side error surfacing ───────────────

test("the validator reads the input byte-identically (no mutation, no side effects)", async () => {
  const p = writeTmp("side-effects.pptx", validPptxZip([{ text: "hi" }]));
  const beforeBuf = fs.readFileSync(p);
  await validatePptx(p);
  assert.deepEqual(fs.readFileSync(p), beforeBuf);
});
