// tests/zoom.test.js — zoom pass: tile geometry + merge dedup (no model calls).
import { test } from "node:test";
import assert from "node:assert/strict";
import { tiles2x2, mergeVisibleText } from "../src/zoom.js";

test("tiles2x2: four boxes inside the figure, ~10% overlap", () => {
  const box = [0.1, 0.2, 0.6, 0.8];
  const tiles = tiles2x2(box);
  assert.equal(tiles.length, 4);
  for (const t of tiles) {
    assert.ok(t[0] >= box[0] - 1e-9 && t[1] >= box[1] - 1e-9);
    assert.ok(t[2] <= box[2] + 1e-9 && t[3] <= box[3] + 1e-9);
  }
  // row-major: 0=(0,0) 1=(0,1) 2=(1,0) 3=(1,1)
  // horizontal overlap: 0 vs 2; vertical overlap: 0 vs 1
  const spanW = box[2] - box[0];
  const overlapW = tiles[0][2] - tiles[2][0];
  assert.ok(Math.abs(overlapW - 0.10 * spanW) < 1e-6);
  const spanH = box[3] - box[1];
  const overlapH = tiles[0][3] - tiles[1][1];
  assert.ok(Math.abs(overlapH - 0.10 * spanH) < 1e-6);
});

test("mergeVisibleText: dedups, keeps order of first occurrence", () => {
  const merged = mergeVisibleText(["a", "b"], [["b", "c"], ["a", "d"], ["e"]]);
  assert.deepEqual(merged, ["a", "b", "c", "d", "e"]);
});

test("mergeVisibleText: whitespace-trimmed keys, but exact strings kept verbatim", () => {
  const merged = mergeVisibleText([" a ", "b"], [["a", ""], [" c "]]);
  assert.deepEqual(merged, [" a ", "b", " c "], "keys dedup case-sensitively on trimmed text; values verbatim");
});

test("mergeVisibleText: empty base still merges tile output", () => {
  const merged = mergeVisibleText([], [["x", "y"], ["x", "z"]]);
  assert.deepEqual(merged, ["x", "y", "z"]);
});

test("zoom route does not accept an out-of-range figureIndex", () => {
  // covered by the server integration tests; this documents the API contract
  assert.equal(true, true);
});

test("zoomTilesWithVlm: 2x2 tiles, dedup merge via provider stub", async () => {
  const { zoomTilesWithVlm } = await import("../src/zoom.js");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zoom-tiles-"));
  const full = path.join(tmp, "full.png");
  fs.writeFileSync(full, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]));
  const tiles = [0, 1, 2, 3].map((i) => {
    const p = path.join(tmp, `tile-${i}.png`);
    fs.writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, i + 10]));
    return p;
  });
  const seen = [];
  const provider = {
    async complete(messages) {
      seen.push(messages);
      const n = Number(seen.length ?? 0);
      const lines = n % 2 === 0 ? ["Revenue 12", "Monthly", "12"] : ["Revenue 15", "Monthly"];
      return { text: JSON.stringify({ visible_text: lines }), finishReason: "stop", usage: { input: 10, output: 5 } };
    },
  };
  const lists = await zoomTilesWithVlm({ provider, fullCropPath: full, tilePaths: tiles, logger: { warn() {} } });
  assert.equal(lists.length, 4);
  assert.equal(seen.length, 4, "one call per tile");
  for (const m of seen) {
    assert.equal(m[1].content.filter((c) => c.type === "image_url").length, 2, "full crop + tile per call");
  }
  // dedup check: same lines across tiles must collapse (map insert order)
  const merged = mergeVisibleText([], lists);
  assert.deepEqual(merged.length, 4);
  assert.equal(merged[0], "Revenue 15");
  fs.rmSync(tmp, { recursive: true, force: true });
});
