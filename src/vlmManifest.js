// src/vlmManifest.js — build the section-tree manifest for a VLM deck from the
// reviewed/approved (merged) slide state. The first pass writes manifest.json at
// analysis time; approve/reopen/export rebuild it from result.json + status.json,
// so the manifest always matches what the reviewer accepted. Pure functions, no I/O.

import { mergeSlides } from "./mergeMain.js";

function groupConsecutiveBullets(slidesBlocks) {
  // Per-slide: merge consecutive bullet text blocks into one list block.
  const out = [];
  let list = null;
  const flush = () => { if (list) out.push(list); list = null; };
  for (const b of slidesBlocks) {
    if (b.role === "bullet") {
      if (!list) list = { type: "list", items: [], level: b.level ?? 0, caption: null, needs_review: false };
      list.items.push(b.text);
    } else {
      flush();
      out.push(b);
    }
  }
  flush();
  return out;
}

export function chartTypeFromNative(hint) {
  const raw = String(hint?.chart_type ?? "").toUpperCase();
  if (raw.includes("BAR") || raw.includes("COLUMN")) return "bar";
  if (raw.includes("LINE")) return "line";
  if (raw.includes("PIE") || raw.includes("DOUGHNUT")) return "pie";
  if (raw.includes("SCATTER")) return "scatter";
  return "other";
}

/**
 * Map one merged slide to manifest content blocks.
 * Stage parity with the hybrid path: tables carry a strict 1 header row when
 * headers exist; figures become chart blocks; speaker notes become a notes block.
 * `pending` adds `review_status: "pending"` on table/chart blocks and keeps the
 * first-pass needs_review computation; approved slides clear it and mark nothing.
 */
export function slideToBlocks(slideJson, hint, { pending = false } = {}) {
  const blocks = [];
  const base = { page: slideJson.slide, caption: null, needs_review: false };
  if (slideJson.subtitle) blocks.push({ ...base, type: "text", content: String(slideJson.subtitle) });
  const tb = groupConsecutiveBullets(slideJson.text_blocks ?? []);
  for (const b of tb) {
    if (b.type === "list") blocks.push({ ...base, type: "list", items: b.items });
    else {
      const role = b.role ?? "body";
      if (role === "heading") blocks.push({ ...base, type: "heading", content: b.text, level: Math.max(2, Math.min(6, (b.level ?? 0) + 2)) });
      else if (role === "caption") blocks.push({ ...base, type: "text", content: b.text });
      else if (role === "footer" || role === "note") blocks.push({ ...base, type: "notes", content: b.text });
      else blocks.push({ ...base, type: "text", content: b.text });
    }
  }
  for (const t of slideJson.tables ?? []) {
    blocks.push({ ...base, type: "table", header_rows: (t.headers?.length ? 1 : 0), content: { columns: t.headers ?? [], rows: t.rows ?? [] }, ...(pending ? { review_status: "pending" } : {}) });
  }
  const hintCharts = hint?.charts ?? [];
  for (const [i, fig] of (slideJson.figures ?? []).entries()) {
    const chartHint = hintCharts[i];
    const hasData = Boolean(fig?.data?.series?.length);
    // Native hint boxes win the bbox slot when the figure lacks its own.
    const nativeBox = fig.bbox ?? chartHint?.bbox ?? null;
    blocks.push({
      ...base,
      type: "chart",
      chart_type: chartTypeFromNative(chartHint),
      title: fig.title ?? chartHint?.title ?? null,
      description: fig.description ?? null,
      evidence: fig.explanation_evidence ?? [],
      content: fig.data ? { ...fig.data } : null,
      estimates: hasData,
      needs_review: pending ? (slideJson.confidence === "low" || !hasData) : false,
      ...(pending ? { review_status: "pending" } : {}),
      ...(nativeBox && !fig.bbox ? { bbox: nativeBox, bbox_source: "native" } : {}),
      ...(fig.bbox ? { bbox: fig.bbox, bbox_source: fig.bbox_source ?? "model" } : {}),
    });
  }
  if (slideJson.speaker_notes) blocks.push({ ...base, type: "notes", content: slideJson.speaker_notes, caption: "Speaker notes" });
  return blocks;
}

/**
 * Build the full manifest document from a result.json-shaped object plus its
 * status map (the same store mergeMain uses for main.json). The returned object
 * is deterministic for identical inputs.
 *   - excluded figures are absent (they were dropped at the merge step)
 *   - pending (not yet approved) slides carry review_status "pending" on
 *     table/chart blocks; approved slides carry none and clear needs_review
 *   - failed slides become a notes block marked needs_review
 * `hints` must be positional (index i ↔ slide i + 1) with hidden/empty slides
 * already compacted out, exactly as the first pass used them; a mismatched
 * length is ignored rather than trusted.
 */
export function buildManifest(result, statuses, hints, opts = {}) {
  const merged = mergeSlides(result, statuses, { keepBox: true });
  const hintList = Array.isArray(hints) ? hints : [];
  const hintsForPages = hintList.length === merged.slides.length ? hintList : [];
  const sections = merged.slides.map((s, i) => {
    const n = s?.slide ?? i + 1;
    if (s?.failed) {
      return {
        id: `s${String(n).padStart(3, "0")}`,
        heading: `Slide ${n} — analysis failed`,
        level: 1,
        pages: [n],
        content: [{ page: n, bbox: null, caption: "slide analysis failed", needs_review: true, type: "notes", content: s.issues?.[0] ?? "VLM analysis failed" }],
        subsections: [],
      };
    }
    const pending = s.review_status === "pending";
    const blocks = slideToBlocks(s, hintsForPages[i] ?? null, { pending });
    const withIds = blocks.map((b, j) => ({ ...b, id: `b${String(n).padStart(3, "0")}-${String(j + 1).padStart(2, "0")}` }));
    return {
      id: `s${String(n).padStart(3, "0")}`,
      heading: s.title ? String(s.title) : `Slide ${n}`,
      level: 1,
      pages: [n],
      content: withIds,
      subsections: [],
    };
  });
  const jobId = merged.jobId ?? "unknown";
  return {
    id: `doc_vlm_${jobId}`,
    subject: result?.subject ?? "unknown",
    subject_source: result?.subject_source ?? "unavailable",
    source_file: opts.sourceFile ?? result?.source_file ?? merged.input ?? "unknown.pptx",
    pages: merged.slides.length,
    sections,
  };
}
