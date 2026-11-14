// tests/schema.test.js — manifest-level validation of a fully assembled manifest.
import { test } from "node:test";
import assert from "node:assert/strict";

import { chunkDocument } from "../src/chunker.js";
import { assignElementIds, headingElement, paragraphElement } from "../src/elements.js";
import { validateManifest } from "../src/schema.js";

test("a stitched+chunked manifest passes the manifest schema", () => {
  const elements = assignElementIds([
    headingElement({ page: 1, bbox: [0.1, 0.05, 0.9, 0.12], text: "Doc", level: 1, source: "script" }),
    paragraphElement({ page: 1, bbox: [0.1, 0.15, 0.9, 0.3], text: "Hello world.", source: "script" }),
  ]);
  const { chunks, toc } = chunkDocument(elements, { maxTokens: 800, minTokens: 1 });
  const manifest = {
    document: {
      source_file: "/tmp/example.pdf",
      pages: 1,
      mode: "hybrid-florence",
      model: "florence-2-large",
      schema_version: "1",
      created_at: new Date().toISOString(),
      toc,
    },
    chunks,
  };
  const { ok, errors } = validateManifest(manifest);
  assert.ok(ok, errors);
});
