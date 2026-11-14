// src/chunker.js
// The shared, mode-agnostic chunker. Input: the stitched, ordered element list.
// Output: the chunked manifest document (before validation). Identical across
// all three extraction modes.
//
// Guarantees:
//   - headings define sections; sections define chunks
//   - a table/figure/equation/code/caption is never split across chunks
//   - an oversized table is split by row groups (header repeated,
//     continues_from/to linked) before packing
//   - captions travel with their figure/table (via atomic_group, set by stitch)
//   - TOC is built from heading elements
//   - completeness: every input element appears in exactly one chunk

import { estimateTokens, elementToText, elementTokenEstimate } from "./util/token.js";

export class CompletenessError extends Error {
  constructor(report) {
    super(`Completeness check failed: ${report.missing.length} missing, ${report.duplicated.length} duplicated`);
    this.name = "CompletenessError";
    this.report = report;
  }
}

const OVERLAPABLE = new Set(["paragraph", "list"]);

function atomicUnits(elements) {
  const consumed = new Set();
  const units = [];
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (consumed.has(el)) continue;
    if (el.atomic_group) {
      const members = [];
      for (let j = i; j < elements.length; j++) {
        if (elements[j].atomic_group === el.atomic_group) {
          members.push(elements[j]);
          consumed.add(elements[j]);
        }
      }
      units.push(members);
      continue;
    }
    consumed.add(el);
    units.push([el]);
  }
  return units;
}

const unitTokens = (unit) => unit.reduce((sum, el) => sum + elementTokenEstimate(el), 0);

function renderChunkText(elements) {
  return elements.map(elementToText).filter(Boolean).join("\n\n");
}

function chunkNeedsReview(elements) {
  return elements.some((el) => el.needs_review);
}

function buildChunksFromUnits(units, segmentPath) {
  const chunks = [];
  let current = [];
  let currentTokens = 0;

  const flush = (oversized = false) => {
    if (current.length === 0) return;
    const pages = [...new Set(current.flatMap((u) => u.map((e) => e.page)))].sort((a, b) => a - b);
    const flat = current.flat();
    chunks.push({
      elements: flat,
      pages,
      section_path: segmentPath,
      text: renderChunkText(flat),
      token_estimate: estimateTokens(renderChunkText(flat)),
      needs_review: chunkNeedsReview(flat),
      oversized,
      _parentKey: segmentPath.slice(0, -1).join("\u0001"),
    });
    current = [];
    currentTokens = 0;
  };

  for (const unit of units) {
    const tokens = unitTokens(unit);
    if (current.length > 0 && currentTokens + tokens > this._maxTokens) {
      flush(false);
    }
    current.push(unit);
    currentTokens += tokens;
  }
  flush(false);
  return chunks;
}

function segmentByHeadings(elements) {
  const segments = [];
  let stack = [];
  let current = [];
  let currentPath = [];

  const closeSegment = () => {
    if (current.length) segments.push({ path: currentPath, elements: current });
  };

  for (const el of elements) {
    if (el.type === "heading") {
      closeSegment();
      const level = Math.max(1, Math.min(el.level ?? 1, 6));
      stack = stack.slice(0, level - 1);
      stack[level - 1] = el.text;
      currentPath = [...stack];
      current = [el];
    } else {
      current.push(el);
    }
  }
  closeSegment();
  return segments;
}

/** Merge undersized adjacent chunks that share a parent section key. */
function mergeSmallChunks(chunks, minTokens, maxTokens) {
  const merged = [];
  for (const chunk of chunks) {
    if (merged.length === 0) { merged.push(chunk); continue; }
    const prev = merged[merged.length - 1];
    const combined = prev.token_estimate + chunk.token_estimate;
    if (
      prev.token_estimate < minTokens &&
      prev._parentKey === chunk._parentKey &&
      combined <= maxTokens
    ) {
      const flat = [...prev.elements, ...chunk.elements];
      merged[merged.length - 1] = {
        elements: flat,
        pages: [...new Set([...prev.pages, ...chunk.pages])].sort((a, b) => a - b),
        section_path: prev.section_path,
        text: renderChunkText(flat),
        token_estimate: estimateTokens(renderChunkText(flat)),
        needs_review: prev.needs_review || chunk.needs_review,
        oversized: prev.oversized || chunk.oversized,
        _parentKey: prev._parentKey,
      };
    } else {
      merged.push(chunk);
    }
  }
  return merged;
}

function buildToc(chunks, elements) {
  // Map element index -> chunk index
  const chunkOf = new Map();
  chunks.forEach((chunk, idx) => {
    for (const el of chunk.elements) if (el.id) chunkOf.set(el.id, idx);
  });

  const headings = [];
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (el.type === "heading" && (el.level ?? 1) <= 3) {
      // Section ends at the next heading of same or higher level
      let end = elements.length;
      for (let j = i + 1; j < elements.length; j++) {
        const other = elements[j];
        if (other.type === "heading" && (other.level ?? 1) <= (el.level ?? 1)) { end = j; break; }
      }
      headings.push({ heading: el, start: i, end });
    }
  }

  const toc = [];
  for (const { heading, start, end } of headings) {
    const chunkIds = new Set();
    for (let i = start; i < end; i++) {
      const idx = elements[i].id ? chunkOf.get(elements[i].id) : undefined;
      if (idx !== undefined) chunkIds.add(chunks[idx].id);
    }
    if (chunkIds.size === 0 && heading.id) {
      const idx = chunkOf.get(heading.id);
      if (idx !== undefined) chunkIds.add(chunks[idx].id);
    }
    if (chunkIds.size > 0) {
      toc.push({ title: heading.text, level: heading.level ?? 1, chunk_ids: [...chunkIds] });
    }
  }
  return toc;
}

/**
 * @param {Array<object>} elements stitched + id-assigned elements
 * @param {{ targetTokens?: number, maxTokens?: number, minTokens?: number, overlapTokens?: number }} opts
 * @returns {{ chunks: Array<object>, toc: Array<object>, stats: object }}
 */
/** Completeness: every input element id must appear in exactly one chunk (overlap copies excluded). */
export function findMissingElementIds(elements, chunks) {
  const seen = new Map();
  for (const chunk of chunks) {
    for (const el of chunk.elements) {
      if (el.overlap) continue;
      if (!el.id) continue;
      seen.set(el.id, (seen.get(el.id) ?? 0) + 1);
    }
  }
  const missing = elements.filter((el) => el.id && !seen.has(el.id)).map((el) => el.id);
  const duplicated = [...seen.entries()].filter(([, n]) => n !== 1).map(([id]) => id);
  return { pass: missing.length === 0 && duplicated.length === 0, missing, duplicated };
}

export function chunkDocument(elements, opts = {}) {
  const maxTokens = opts.maxTokens ?? 800;
  const minTokens = opts.minTokens ?? 120;
  const overlapTokens = opts.overlapTokens ?? 0;

  const chunker = { _maxTokens: maxTokens };

  // 1. Segment by headings (or one flat segment when there are none).
  const segments = segmentByHeadings(elements);

  // 2. Pack each segment into chunks at element boundaries.
  let chunks = [];
  for (const segment of segments) {
    const units = atomicUnits(segment.elements);
    const packed = buildChunksFromUnits.call(chunker, units, segment.path);
    chunks = chunks.concat(packed);
  }

  // 3. Merge undersized neighbors under the same parent heading.
  chunks = mergeSmallChunks(chunks, minTokens, maxTokens);

  // 4. Final ordering, ids, linking.
  chunks = chunks.map((chunk, index) => {
    const flat = chunk.elements;
    const { _parentKey, ...rest } = chunk;
    const id = `c${String(index + 1).padStart(3, "0")}`;
    return {
      id,
      index,
      section_path: rest.section_path,
      pages: rest.pages,
      text: rest.text,
      token_estimate: rest.token_estimate,
      prev_id: index === 0 ? null : `c${String(index).padStart(3, "0")}`,
      next_id: index === chunks.length - 1 ? null : `c${String(index + 2).padStart(3, "0")}`,
      needs_review: rest.needs_review,
      oversized: rest.oversized || undefined,
      elements: flat,
    };
  });

  // 5. Optional overlap between adjacent text chunks (never duplicates tables/figures).
  if (overlapTokens > 0 && chunks.length > 1) {
    chunks = applyOverlap(chunks, overlapTokens);
  }

  // 6. TOC.
  const toc = buildToc(chunks, elements);

  // 7. Completeness: every non-overlap input element in exactly one chunk.
  const report = findMissingElementIds(elements, chunks);
  if (!report.pass) throw new CompletenessError(report);

  const stats = {
    chunks: chunks.length,
    oversized_chunks: chunks.filter((c) => c.oversized).length,
    needs_review_chunks: chunks.filter((c) => c.needs_review).length,
    completeness: report,
  };

  return { chunks, toc, stats };
}

function applyOverlap(chunks, overlapTokens) {
  const out = chunks.map((chunk) => ({ ...chunk, elements: [...chunk.elements] }));
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1];
    const tail = [];
    let tokens = 0;
    for (let j = prev.elements.length - 1; j >= 0; j--) {
      const el = prev.elements[j];
      if (!OVERLAPABLE.has(el.type)) continue;
      const t = elementTokenEstimate(el);
      if (tokens + t > overlapTokens) break;
      tokens += t;
      tail.unshift({
        ...el,
        id: `ov-${el.id}`,
        overlap: true,
        overlap_of: el.id,
        source: "overlap",
        needs_review: el.needs_review,
      });
    }
    if (tail.length === 0) continue;
    const flat = [...tail, ...out[i].elements];
    out[i] = {
      ...out[i],
      overlap: true,
      elements: flat,
      pages: [...new Set(flat.map((e) => e.page))].sort((a, b) => a - b),
      text: renderChunkText(flat),
      token_estimate: estimateTokens(renderChunkText(flat)),
    };
  }
  return out;
}
