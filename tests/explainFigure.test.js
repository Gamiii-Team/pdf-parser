// tests/explainFigure.test.js — grounded explanation helper (stub provider).
// Generic tokens only — the implementation must not encode domain knowledge.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { explainFigure } from "../src/extract/slideVlm.js";
import { buildFigureContext } from "../src/figureContext.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l6cAAAAASUVORK5CYII=",
  "base64",
);

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "explain-test-"));
  const p = path.join(dir, "crop.png");
  fs.writeFileSync(p, PNG);
  const result = {
    slides: [{
      slide: 1,
      title: "Partners",
      text_blocks: [{ text: "ALPHA works with BETA", role: "body", level: 0 }],
      figures: [{
        type: "diagram",
        title: "Links",
        description: "old positional text",
        visible_text: ["ALPHA", "BETA"],
        data: { labels: ["ALPHA", "BETA"], series: [] },
      }],
    }],
  };
  const context = buildFigureContext({ result, slideNumber: 1, figureIndex: 0 });
  return { dir, p, context, figure: result.slides[0].figures[0] };
}

test("explainFigure returns the explanation and audit for grounded output", async () => {
  const { dir, p, context, figure } = setup();
  try {
    const provider = {
      async complete(messages) {
        const system = messages?.[0]?.content ?? "";
        const user = messages?.[1]?.content?.find((c) => c.type === "text")?.text ?? "";
        assert.match(system, /verbatim/);
        assert.match(user, /<figure_data>/);
        assert.match(user, /<context>/);
        assert.doesNotMatch(user, /old positional text/);
        return {
          text: JSON.stringify({
            explanation: "ALPHA connects to BETA in the partner diagram.",
            evidence: ["ALPHA", "BETA"],
            labels: ["ALPHA", "BETA"],
          }),
          finishReason: "stop",
          usage: { input: 12, output: 9 },
        };
      },
    };
    const out = await explainFigure({ cropPath: p, figure, context, provider, logger: { warn() {} } });
    assert.match(out.explanation, /ALPHA/);
    assert.equal(out.audit.ok, true);
    assert.deepEqual(out.audit.ungrounded, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("explainFigure retries with corrective feedback when labels are ungrounded", async () => {
  const { dir, p, context, figure } = setup();
  try {
    const seen = [];
    let call = 0;
    const provider = {
      async complete(messages) {
        call += 1;
        seen.push(messages?.[1]?.content?.find((c) => c.type === "text")?.text ?? "");
        return {
          text: JSON.stringify({
            explanation: call === 1
              ? "The diagram shows DELTA and OMEGA stakeholders."
              : "The diagram shows ALPHA and BETA.",
            evidence: call === 1 ? ["DELTA", "OMEGA"] : ["ALPHA", "BETA"],
            labels: call === 1 ? ["DELTA", "OMEGA"] : ["ALPHA", "BETA"],
          }),
          finishReason: "stop",
          usage: { input: 1, output: 1 },
        };
      },
    };
    const out = await explainFigure({ cropPath: p, figure, context, provider, logger: { warn() {} } });
    assert.equal(call, 2);
    assert.match(seen[1], /previous answer used labels/);
    assert.equal(out.audit.ok, true); // second attempt is grounded
    assert.match(out.explanation, /ALPHA/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("explainFigure throws after two malformed responses", async () => {
  const { dir, p, context, figure } = setup();
  try {
    let calls = 0;
    const provider = {
      async complete() {
        calls += 1;
        return { text: JSON.stringify({ explanation: "fine" }), finishReason: "stop", usage: { input: 1, output: 1 } };
      },
    };
    await assert.rejects(
      explainFigure({ cropPath: p, figure, context, provider, logger: { warn() {} } }),
      /explain-figure failed/,
    );
    assert.equal(calls, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
