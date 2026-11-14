// tests/treeBuilder.test.js

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildTree, countSections } from "../src/extract/treeBuilder.js";

test("flat blocks before first heading get a synthetic root", () => {
  const tree = buildTree([{ type: "text", page: 1, bbox: [0, 10, 100, 20], content: "orphan" }]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].heading, "Document");
  assert.equal(tree[0].level, 1);
  assert.equal(tree[0].content.length, 1);
});

test("headings nest recursively by level", () => {
  const tree = buildTree([
    { type: "heading", page: 1, bbox: [0, 10, 100, 20], content: "A", level: 1 },
    { type: "heading", page: 1, bbox: [0, 30, 100, 40], content: "B", level: 2 },
    { type: "heading", page: 1, bbox: [0, 50, 100, 60], content: "C", level: 2 },
    { type: "heading", page: 1, bbox: [0, 70, 100, 80], content: "D", level: 1 },
  ]);
  assert.deepEqual(tree.map((s) => s.heading), ["A", "D"]);
  assert.deepEqual(tree[0].subsections.map((s) => s.heading), ["B", "C"]);
});

test("content lands in the deepest open section and page ids are unique", () => {
  const tree = buildTree([
    { type: "heading", page: 1, bbox: [0, 10, 100, 20], content: "A", level: 1 },
    { type: "text", page: 1, bbox: [0, 30, 100, 40], content: "t1" },
    { type: "heading", page: 1, bbox: [0, 50, 100, 60], content: "B", level: 2 },
    { type: "text", page: 2, bbox: [0, 10, 100, 20], content: "t2" },
  ]);
  assert.deepEqual(tree[0].subsections.map((s) => s.content.map((c) => c.content)), [["t2"]]);
  assert.deepEqual(tree[0].content.map((c) => c.content), ["t1"]);
  const ids = new Set();
  const walk = (s) => { for (const c of s.content) ids.add(c.id); for (const sub of s.subsections) walk(sub); };
  for (const s of tree) walk(s);
  assert.equal(ids.size, 2); // b001-style unique ids
});

test("sections carry unique ascending ids and block counts reported", () => {
  const tree = buildTree([
    { type: "heading", page: 1, bbox: [0, 10, 100, 20], content: "A", level: 1 },
    { type: "text", page: 1, bbox: [0, 30, 100, 40], content: "t" },
    { type: "heading", page: 1, bbox: [0, 50, 100, 60], content: "B", level: 2 },
  ]);
  assert.ok(tree[0].id);
  assert.equal(countSections(tree), 2);
});
