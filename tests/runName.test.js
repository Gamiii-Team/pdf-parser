// tests/runName.test.js — self-describing run folder names

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  slugify,
  stripExt,
  modelSlug,
  genRunId,
  formatRunFolder,
} from "../src/util/runName.js";

test("slugify lower-cases, sanitizes, collapses and truncates", () => {
  assert.equal(slugify("My File (final).PDF"), "my-file-final.pdf");
  assert.equal(slugify("a___b   c"), "a-b-c");
  assert.equal(slugify("---weird__name--"), "weird-name");
  assert.equal(slugify(""), "input");
  assert.equal(slugify(null), "input");
  assert.equal(slugify("x".repeat(100), 10), "x".repeat(10));
});

test("stripExt strips the trailing extension only", () => {
  assert.equal(stripExt("scan.pdf"), "scan");
  assert.equal(stripExt("archive.tar.gz"), "archive.tar");
  assert.equal(stripExt("noext"), "noext");
  assert.equal(stripExt(".pdf"), ".pdf"); // no base name → keep as-is (slugify handles it)
  assert.equal(stripExt("/tmp/dir/Invoice 2.PNG"), "Invoice 2");
});

test("modelSlug drops the org prefix and lower-cases", () => {
  assert.equal(modelSlug("qwen/qwen3.8-27b"), "qwen3.8-27b");
  assert.equal(modelSlug("Qwen/Qwen3-VL-8B-Instruct-FP8"), "qwen3-vl-8b-instruct-fp8");
  assert.equal(modelSlug("gpt-oss-20b"), "gpt-oss-20b");
  assert.equal(modelSlug(""), "model");
});

test("genRunId is 16 lowercase hex chars", () => {
  assert.match(genRunId(), /^[0-9a-f]{16}$/);
});

test("formatRunFolder builds <runId>_<input>_<backend>-<model>", () => {
  const name = formatRunFolder({
    backend: "groq",
    model: "qwen/qwen3.8-27b",
    inputName: "test.pdf",
    runId: "0b671f7bee35e952",
  });
  assert.equal(name, "0b671f7bee35e952_test_groq-qwen3.8-27b");
});

test("formatRunFolder with a modal model drops the org prefix", () => {
  const name = formatRunFolder({
    backend: "modal",
    model: "Qwen/Qwen3-VL-8B-Instruct-FP8",
    inputName: "Invoice #42 (Q3).pdf",
    runId: "9f8e7d6c5b4a3210",
  });
  assert.equal(name, "9f8e7d6c5b4a3210_invoice-42-q3_modal-qwen3-vl-8b-instruct-fp8");
});

test("formatRunFolder omits the model slug when no model is active", () => {
  const name = formatRunFolder({
    backend: "none",
    model: "",
    inputName: "test.pdf",
    runId: "4b0cb96367cf6006",
  });
  assert.equal(name, "4b0cb96367cf6006_test_none");
});

test("formatRunFolder: segments contain no underscores and runId is a leading prefix", () => {
  const runId = genRunId();
  const name = formatRunFolder({
    backend: "groq",
    model: "org/odd__model/name",
    inputName: "weird__file name.pdf",
    runId,
  });
  const segments = name.split("_");
  assert.equal(segments.length, 3);
  assert.equal(name.startsWith(`${runId}_`), true);
});

test("formatRunFolder generates a runId when omitted", () => {
  const name = formatRunFolder({ backend: "groq", model: "m", inputName: "x.pdf" });
  assert.match(name.split("_")[0], /^[0-9a-f]{16}$/);
});
