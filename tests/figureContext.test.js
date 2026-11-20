// tests/figureContext.test.js — deterministic context packet + grounding audit.
// No VLM, no network. Generic tokens only — nothing domain-specific is hardcoded.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildFigureContext, auditExplanation, normalizeTerm } from "../src/figureContext.js";

const RESULT = {
  slides: [
    {
      slide: 1,
      title: "Alpha overview",
      text_blocks: [
        { text: "Direction for the quarter", role: "heading", level: 0 },
        { text: "The first body block", role: "body", level: 0 },
      ],
      tables: [{ headers: ["Metric", "Value"], rows: [["Adoption", "42"]] }],
      speaker_notes: "Introduce the partners.",
      figures: [{
        type: "diagram",
        title: "Partner topology",
        description: "An explainer written by a previous VLM that must not leak into context",
        visible_text: ["ALPHA", "BETA", "GAMMA"],
        data: { labels: ["ALPHA", "BETA"], series: [{ name: "GAMMA", values: [1, 2] }] },
      }],
    },
    { slide: 2, title: "Second slide", text_blocks: [], figures: [] },
  ],
};

const HINTS = [{
  charts: [{ title: "Native title", x: ["ALPHA", "GAMMA"], series: [{ name: "BETA" }] }],
  tables: [{ headers: ["Metric"], rows: [["Adoption"]] }],
}];

test("buildFigureContext includes figure data, slide text, deck outline and native hints", () => {
  const ctx = buildFigureContext({ result: RESULT, hints: HINTS, slideNumber: 1, figureIndex: 0 });
  assert.match(ctx.text, /<figure_data>/);
  assert.match(ctx.text, /Partner topology/);
  assert.match(ctx.text, /ALPHA/);
  assert.match(ctx.text, /<current_slide>/);
  assert.match(ctx.text, /The first body block/);
  assert.match(ctx.text, /native_document_data/);
  assert.match(ctx.text, /Native title/);
  assert.match(ctx.text, /<deck_outline>/);
  assert.match(ctx.text, /Second slide/);
  assert.ok(ctx.terms.includes("ALPHA"));
  assert.equal(ctx.slideNumber, 1);
});

test("buildFigureContext never feeds previous free-form descriptions back in", () => {
  const ctx = buildFigureContext({ result: RESULT, hints: HINTS, slideNumber: 1, figureIndex: 0 });
  assert.doesNotMatch(ctx.text, /previous VLM/);
  assert.doesNotMatch(ctx.text, /explainer written/);
  assert.equal(ctx.terms.some((t) => String(t).includes("previous VLM")), false);
});

test("buildFigureContext is deterministic and respects the character budget", () => {
  const a = buildFigureContext({ result: RESULT, hints: HINTS, slideNumber: 1, figureIndex: 0, maxChars: 700 });
  const b = buildFigureContext({ result: RESULT, hints: HINTS, slideNumber: 1, figureIndex: 0, maxChars: 700 });
  assert.equal(a.text, b.text);
  assert.ok(a.text.length <= 700);
  assert.match(a.text, /truncated/);
});

test("auditExplanation accepts claims grounded in the packet", () => {
  const ctx = buildFigureContext({ result: RESULT, hints: HINTS, slideNumber: 1, figureIndex: 0 });
  const audit = auditExplanation({
    explanation: "ALPHA and BETA connect to GAMMA.",
    evidence: ["ALPHA", "BETA", "GAMMA"],
    labels: ["ALPHA", "BETA", "GAMMA"],
    context: ctx,
  });
  assert.equal(audit.ok, true);
  assert.deepEqual(audit.ungrounded, []);
  assert.deepEqual(audit.flaggedProperNouns, []);
});

test("auditExplanation flags invented labels and ungrounded proper nouns", () => {
  const ctx = buildFigureContext({ result: RESULT, hints: HINTS, slideNumber: 1, figureIndex: 0 });
  const audit = auditExplanation({
    explanation: "The diagram separates DELTA and OMEGA participants.",
    evidence: ["DELTA", "OMEGA"],
    labels: ["DELTA", "OMEGA"],
    context: ctx,
  });
  assert.equal(audit.ok, false);
  assert.deepEqual(audit.ungrounded, ["DELTA", "OMEGA"]);
  assert.deepEqual(audit.flaggedProperNouns, ["DELTA", "OMEGA"]);
});

test("auditExplanation ignores generic sentence-start words and stopword phrases", () => {
  const ctx = buildFigureContext({ result: RESULT, hints: HINTS, slideNumber: 1, figureIndex: 0 });
  const audit = auditExplanation({
    explanation: "The Figure shows the Data clearly.",
    evidence: [],
    labels: [],
    context: ctx,
  });
  assert.deepEqual(audit.flaggedProperNouns, []);
});

test("normalizeTerm strips bullet prefixes, punctuation and case", () => {
  assert.equal(normalizeTerm("  •  ALPHA. "), "alpha");
  assert.equal(normalizeTerm("1) Native Title"), "native title");
});
