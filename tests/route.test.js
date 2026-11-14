// tests/route.test.js — §2 per-page routing logic

import { test } from "node:test";
import assert from "node:assert/strict";

import { routePages } from "../src/input/router.js";

const p = (page, textChars, imageCover = 0) => ({ page, text_chars: textChars, image_cover_frac: imageCover });
const analysis = (pages) => ({ num_pages: pages.length, pages });

test("born-digital pages route to text-layer", () => {
  const routed = routePages(analysis([p(1, 660, 0), p(2, 410, 0.16)]));
  assert.equal(routed[0].route, "text-layer");
  assert.equal(routed[1].route, "text-layer");
});

test("no text layer routes to vlm", () => {
  const routed = routePages(analysis([p(1, 0, 1)]));
  assert.equal(routed[0].route, "vlm");
});

test("image coverage >= 0.9 forces vlm even with text", () => {
  const routed = routePages(analysis([p(1, 5000, 0.9)]));
  assert.equal(routed[0].route, "vlm");
});

test("forceVlm overrides everything", () => {
  const routed = routePages(analysis([p(1, 9999, 0)]), { forceVlm: true });
  assert.equal(routed[0].route, "vlm");
});

test("empty text below MIN_CHARS still routes to text-layer when >= threshold", () => {
  const routed = routePages(analysis([p(1, 80, 0)]));
  assert.equal(routed[0].route, "text-layer");
});
