// src/extract/textPage.js
// Text-layer path (§2a). Produces flat typed blocks in reading order.
// No models are called here (VLM crops are added separately via extract/figures.js).
//
// Block types emitted:
//   { type: "heading", level: 1..3, page, bbox, content }
//   { type: "text", page, bbox, content }
//   { type: "list", items: [string], page, bbox }
//   { type: "table", page, bbox, caption?, header_rows, content: { columns, rows } }
//   { type: "figure" | "image" , page, bbox, caption? }   (VLM call fills the rest later)

const BULLET_GLYPH_RE = /^[•◦‣·\-\u2010\u2011\u2012\u2013\u2014\*]\s*/;
const NUMBERED_RE = /^(\d+[.)])\s+/;
const LETTERS_RE = /^([a-z][.)])\s+/i;
const CAPTION_RE = /^(figure|fig\.?|table|exhibit|chart|graph|equation|eq\.?)\s*\d+/i;

export function findBodyFontSize(pages) {
  const counter = new Map();
  for (const p of pages ?? []) {
    for (const line of p?.lines ?? []) {
      for (const s of line.spans ?? []) {
        const key = Math.round(s.fontSize * 2) / 2;
        counter.set(key, (counter.get(key) ?? 0) + (s.text?.length ?? 0));
      }
    }
  }
  let best = { size: 11, count: 0 };
  for (const [size, count] of counter) {
    if (count > best.count) best = { size, count };
  }
  return best.size;
}

function isHeadingSpan(span, bodySize) {
  const diff = span.fontSize - bodySize;
  if (span.bold && diff >= -0.5) return true;
  if (diff >= 2) return true;
  return false;
}
const lineIsAllHeading = (line, bodySize) => line.spans?.length && line.spans.every((s) => isHeadingSpan(s, bodySize));

function detectHeadingSizes(pages, bodySize) {
  const set = new Set();
  for (const p of pages ?? []) {
    for (const line of p?.lines ?? []) {
      if (lineIsAllHeading(line, bodySize)) {
        for (const s of line.spans) set.add(s.fontSize);
      }
    }
  }
  return [...set].sort((a, b) => b - a).slice(0, 3);
}

const round1 = (n) => Math.round(Number(n) * 10) / 10;
const mergeBBox = (boxes) => [
  round1(Math.min(...boxes.map((b) => b[0]))),
  round1(Math.min(...boxes.map((b) => b[1]))),
  round1(Math.max(...boxes.map((b) => b[2]))),
  round1(Math.max(...boxes.map((b) => b[3]))),
];
const clampBBox = (b) => [round1(b[0]), round1(b[1]), round1(b[2]), round1(b[3])];
const unionOverlap = (a, b) => {
  const ix1 = Math.max(a[0], b[0]), iy1 = Math.max(a[1], b[1]);
  const ix2 = Math.min(a[2], b[2]), iy2 = Math.min(a[3], b[3]);
  if (ix2 <= ix1 || iy2 <= iy1) return 0;
  return ((ix2 - ix1) * (iy2 - iy1)) / Math.max(1, (a[2] - a[0]) * (a[3] - a[1]));
};

function approxLineNoise(text) {
  const weird = (text.match(/[^\x20-\x7E]/g) ?? []).length;
  return weird > text.length * 0.5;
}

/** Phase 1: classify lines into typed raw blocks. */
function classifyLines(pages, bodySize) {
  const sizes = detectHeadingSizes(pages, bodySize);
  const levelMap = new Map(sizes.map((sz, i) => [sz, i + 1]));
  const out = [];
  let textBuf = [];
  let pendingBullet = false;
  const flushText = () => {
    if (!textBuf.length) return;
    const bbox = mergeBBox(textBuf.map((l) => l.bbox));
    const text = textBuf.map((l) => l.text).join(" ").replace(/\s+/g, " ").trim();
    out.push({ type: "text", page: textBuf[0].page, bbox, content: text });
    textBuf = [];
  };

  for (const page of pages ?? []) {
    for (const line of (page?.lines ?? []).map((l) => ({ ...l, page: page.page }))) {
      if (!line.spans?.length) continue;
      const trimmed = line.text.trim();
      // Bullet-as-line: mark next text line as list-item
      if (/^[•◦‣·\u2022\u25E6\u25AA\u2013\u2014\u00B7\s]+$/.test(trimmed) || trimmed === "•" || trimmed === "-" || trimmed === "*" || trimmed === "◦") {
        pendingBullet = true;
        continue;
      }
      // Caption detection first (any size)
      if (CAPTION_RE.test(trimmed)) {
        flushText();
        out.push({ type: "caption", page: page.page, bbox: line.bbox.slice(), content: trimmed });
        pendingBullet = false;
        continue;
      }
      if (lineIsAllHeading(line, bodySize)) {
        flushText();
        const first = line.spans[0];
        const lv = (levelMap.get(first.fontSize) ?? sizes.length) || 3;
        out.push({ type: "heading", page: page.page, bbox: line.bbox.slice(), content: trimmed, level: lv });
        pendingBullet = false;
        continue;
      }
      if (pendingBullet || BULLET_GLYPH_RE.test(trimmed) || NUMBERED_RE.test(trimmed) || LETTERS_RE.test(trimmed)) {
        flushText();
        const item = trimmed.replace(BULLET_GLYPH_RE, "").replace(NUMBERED_RE, "").replace(LETTERS_RE, "").trim();
        out.push({ type: "list-item", page: page.page, bbox: line.bbox.slice(), content: item });
        pendingBullet = false;
        continue;
      }
      const prev = textBuf[textBuf.length - 1];
      if (prev && (line.bbox[1] - prev.bbox[3]) > 2) flushText();
      textBuf.push(line);
    }
  }
  flushText();

  // Phase 2: group consecutive list-items into one list block
  const merged = [];
  let lb = [];
  const flushList = () => {
    if (!lb.length) return;
    merged.push({
      type: "list",
      page: lb[0].page,
      bbox: mergeBBox(lb.map((i) => i.bbox)),
      items: lb.map((i) => i.content),
    });
    lb = [];
  };
  for (const item of out) {
    if (item.type === "list-item") { lb.push(item); continue; }
    flushList();
    merged.push(item);
  }
  flushList();
  return merged;
}

/** Phase 3: turn tables into structured blocks; mark consumed caption blocks as used. */
function emitTables(pages, rawWithIdx) {
  const usedIdx = new Set();           // indices into rawWithIdx that were consumed
  const out = [];

  const captionDistance = (captionBlock, tableBlock) => {
    const [cx0, cy0, cx1, cy1] = [captionBlock.bbox[0], captionBlock.bbox[1], captionBlock.bbox[2], captionBlock.bbox[3]];
    const [tx0, ty0, tx1, ty1] = tableBlock.bbox;
    const dx = Math.max(0, tx0 - cx1, cx0 - tx1);
    const dy = Math.max(0, ty0 - cy1, cy0 - ty1);
    return dx + dy;
  };

  const consumeCaption = (table) => {
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < rawWithIdx.length; i++) {
      if (usedIdx.has(i)) continue;
      const b = rawWithIdx[i];
      if (b.type !== "caption") continue;
      const d = captionDistance(b, table);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    if (bestIdx !== -1 && bestDist < 50) {
      usedIdx.add(bestIdx);
      return rawWithIdx[bestIdx].content;
    }
    return null;
  };

  for (const page of pages ?? []) {
    for (const t of page?.tables ?? []) {
      if (!t?.cells?.length) continue;
      const bbox = clampBBox(t.bbox);
      const rows = t.cells.map((row) => (Array.isArray(row) ? row.map((c) => String(c ?? "").trim()) : []));
      const firstRow = rows[0] ?? [];
      const headerRows = firstRow.every((c) => c && c.length <= 60) ? 1 : 0;
      const columns = headerRows ? rows[0] : [];
      const bodyRows = headerRows ? rows.slice(1) : rows;
      const caption = consumeCaption(t);
      out.push({
        type: "table",
        page: page.page,
        bbox,
        caption,
        content: { columns, rows: bodyRows },
        header_rows: headerRows,
      });
    }
  }
  // Everything in rawWithIdx not used remains in the output
  return { tableBlocks: out, usedIdx };
}

/** Phase 4: detect figure/image regions; mark matching captions as used. */
function emitFigures(pages, rawWithIdx, tableBlocks, tableUsedIdx) {
  const out = [];
  const usedIdx = new Set(tableUsedIdx);

  const findCaption = (target) => {
    let best = -1, bestDist = Infinity;
    const targetCenter = (target.bbox[1] + target.bbox[3]) / 2;
    for (let i = 0; i < rawWithIdx.length; i++) {
      if (usedIdx.has(i)) continue;
      const b = rawWithIdx[i];
      if (b.type !== "caption" || b.page !== target.page) continue;
      const captionCenter = (b.bbox[1] + b.bbox[3]) / 2;
      const dist = Math.abs(captionCenter - targetCenter);
      if (dist < bestDist && dist < 200) { bestDist = dist; best = i; }
    }
    if (best === -1) return null;
    usedIdx.add(best);
    return rawWithIdx[best].content;
  };

  for (const page of pages ?? []) {
    for (const img of page?.images ?? []) {
      const b = clampBBox(img.bbox);
      if (coversMostOfPage(b, page)) continue;
      if (overlapsAnyTable(b, tableBlocks)) continue;
      out.push({
        type: "figure-image",
        page: page.page,
        bbox: b,
        caption: findCaption({ bbox: b, page: page.page }),
      });
    }
    for (const d of page?.drawings ?? []) {
      const b = clampBBox(d.bbox);
      if ((b[2] - b[0]) < 40 || (b[3] - b[1]) < 40) continue;
      if (coversMostOfPage(b, page)) continue;
      if (overlapsAnyTable(b, tableBlocks)) continue;
      out.push({
        type: "figure-vector",
        page: page.page,
        bbox: b,
        caption: findCaption({ bbox: b, page: page.page }),
      });
    }
  }
  // Exclude any figure overlapping a table
  const kept = out.filter((f) => !overlapsAnyTable(f.bbox, tableBlocks));
  return { figureBlocks: kept, usedIdx };
}

const coversMostOfPage = (b, page) => {
  const w = b[2] - b[0], h = b[3] - b[1];
  return w > page.width * 0.9 && h > page.height * 0.9;
};

const overlapsAnyTable = (b, tableBlocks) =>
  tableBlocks.some((t) => unionOverlap(t.bbox, b) > 0.6);

/**
 * Main entry: worker pages → flat typed blocks.
 */
export function extractTextPage(pages) {
  const bodySize = findBodyFontSize(pages);
  const rawBlocks = classifyLines(pages, bodySize);
  const rawWithIdx = rawBlocks.map((b, i) => ({ ...b, _idx: i }));
  const { tableBlocks, usedIdx: tableUsedIdx } = emitTables(pages, rawWithIdx);
  const { figureBlocks, usedIdx } = emitFigures(pages, rawWithIdx, tableBlocks, tableUsedIdx);
  const otherBlocks = rawWithIdx
    .filter((_, i) => !usedIdx.has(i))
    .map(({ _idx, ...rest }) => rest);
  const merged = [...tableBlocks, ...figureBlocks, ...otherBlocks];
  merged.sort((a, b) => (a.page - b.page) || (a.bbox?.[1] ?? 0) - (b.bbox?.[1] ?? 0) || (a.bbox?.[0] ?? 0) - (b.bbox?.[0] ?? 0));
  return {
    bodySize,
    blocks: merged,
    textChars: (pages ?? []).reduce((s, p) => s + (p?.text_chars ?? 0), 0),
  };
}
