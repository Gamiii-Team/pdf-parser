// src/figureContext.js — deterministic, VLM-free context packet for figure explanations.
//
// The whole point of this module is to give the explanation step a *fixed* set of
// strings it is allowed to use. Everything here is assembled from data that is
// already on disk (result.json / manifest.json / hints.json) — no new input, no
// hard-coded domain terms, no VLM calls. Free-form `description` fields are
// deliberately excluded so a previous hallucination cannot feed back in.

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "are", "was", "were", "has", "have",
  "its", "their", "they", "them", "into", "over", "under", "each", "every", "not", "but",
  "also", "only", "than", "then", "when", "where", "which", "while", "across", "about",
  "shows", "show", "shown", "figure", "chart", "diagram", "image", "slide", "data", "value",
  "values", "group", "groups", "part", "parts", "item", "items", "label", "labels", "text",
  "english", "translated", "visible", "here", "there", "what", "how", "why", "does", "does",
]);

/** Lowercase, collapse whitespace, drop surrounding punctuation / bullet prefixes. */
export function normalizeTerm(value) {
  return String(value ?? "")
    .replace(/[\s\u00a0]+/g, " ")
    .trim()
    .replace(/^[\s\-–—•*#\d.()[\]>"'`]+/, "")
    .replace(/[\s.,;:!?"'`]+$/g, "")
    .toLowerCase()
    .trim();
}

function pushTerm(terms, seen, value) {
  const raw = String(value ?? "").trim();
  if (!raw) return;
  const key = normalizeTerm(raw);
  if (!key || seen.has(key)) return;
  seen.add(key);
  terms.push(raw);
}

function stringsFromTable(t) {
  const out = [];
  for (const h of t?.headers ?? []) out.push(h);
  for (const row of t?.rows ?? []) for (const cell of row ?? []) out.push(cell);
  return out;
}

function stringsFromHint(hint) {
  const out = [];
  for (const c of hint?.charts ?? []) {
    out.push(c?.title, c?.x_axis_label, c?.y_axis_label);
    for (const x of c?.x ?? c?.categories ?? []) out.push(x);
    for (const s of c?.series ?? []) out.push(s?.name);
  }
  for (const t of hint?.tables ?? []) out.push(...stringsFromTable(t));
  return out;
}

/**
 * Build a bounded context packet plus the exact atomic strings it contains.
 * @param {{ result?: object, hints?: Array, slideNumber?: number, figureIndex?: number, maxChars?: number }} opts
 * @returns {{ text: string, terms: string[], slideNumber: number, figureIndex: number }}
 */
export function buildFigureContext(opts = {}) {
  const result = opts.result ?? {};
  const slides = Array.isArray(result.slides) ? result.slides : [];
  const slideNumber = Number(opts.slideNumber) || 1;
  const figureIndex = Math.max(0, Number(opts.figureIndex) || 0);
  const maxChars = Math.max(500, Number(opts.maxChars) || 7000);

  const slide = slides.find((s) => s?.slide === slideNumber) ?? slides[slideNumber - 1] ?? null;
  const figure = Array.isArray(slide?.figures) ? slide.figures[figureIndex] : null;

  const terms = [];
  const seen = new Set();
  const add = (v) => pushTerm(terms, seen, v);

  // Figure data is authoritative for labels. Structured fields only — never `description`.
  const figureData = figure ? {
    type: figure.type ?? null,
    chart_type: figure.chart_type ?? null,
    title: figure.title ?? null,
    visible_text: figure.visible_text ?? [],
    data: figure.data ?? null,
    content: figure.content ?? null,
  } : {};
  add(figure?.title);
  for (const t of figure?.visible_text ?? []) add(t);
  for (const l of figure?.data?.labels ?? []) add(l);
  for (const s of figure?.data?.series ?? []) add(s?.name);
  for (const x of figure?.content?.x ?? figure?.content?.columns ?? []) add(x);
  for (const s of figure?.content?.series ?? []) add(s?.name);

  // Current slide text (title/headings/body/tables/notes). No generated prose fields.
  add(slide?.title);
  add(slide?.subtitle);
  for (const b of slide?.text_blocks ?? []) add(b?.text);
  for (const t of slide?.tables ?? []) for (const v of stringsFromTable(t)) add(v);
  add(slide?.speaker_notes);

  // Native document data for this slide (exact, from the fed .pptx).
  const hint = Array.isArray(opts.hints) ? opts.hints[slideNumber - 1] : null;
  const native = hint ? {
    charts: (hint.charts ?? []).map((c) => ({
      title: c?.title ?? null, x_axis_label: c?.x_axis_label ?? null, y_axis_label: c?.y_axis_label ?? null,
      x: c?.x ?? c?.categories ?? [], series: (c?.series ?? []).map((s) => s?.name),
    })),
    tables: (hint.tables ?? []).map((t) => ({ headers: t?.headers ?? [], rows: t?.rows ?? [] })),
  } : null;
  for (const v of stringsFromHint(hint)) add(v);

  // Deck-level headings + adjacent slide titles, for situational meaning only.
  const deck = [];
  for (const s of slides) {
    if (!s || s.failed) continue;
    const n = s.slide ?? null;
    const headings = (s.text_blocks ?? []).filter((b) => b?.role === "heading").map((b) => b.text);
    for (const h of headings) add(h);
    if (n != null) deck.push({ slide: n, title: s.title ?? null, headings });
  }
  for (const n of [slideNumber - 1, slideNumber + 1]) {
    const s = slides.find((x) => x?.slide === n);
    add(s?.title);
  }

  // Assemble in priority order under a hard budget.
  const parts = [
    ["figure_data", JSON.stringify(figureData)],
    ["current_slide", JSON.stringify({
      slide: slideNumber,
      title: slide?.title ?? null,
      subtitle: slide?.subtitle ?? null,
      text_blocks: (slide?.text_blocks ?? []).map((b) => b?.text),
      tables: slide?.tables ?? [],
      speaker_notes: slide?.speaker_notes ?? null,
    })],
    ...(native ? [["native_document_data", JSON.stringify(native)]] : []),
    ["deck_outline", JSON.stringify(deck)],
  ];
  let used = 0;
  const rendered = [];
  for (const [name, value] of parts) {
    const sep = rendered.length ? 1 : 0; // join("\n") separator
    const block = `<${name}>${value}</${name}>`;
    if (used + sep + block.length > maxChars) {
      const open = `<${name}>`, close = `</${name}>`, marker = "…[truncated]";
      const room = maxChars - used - sep - open.length - close.length - marker.length;
      if (room > 20) rendered.push(`${open}${value.slice(0, room)}${marker}${close}`);
      break;
    }
    rendered.push(block);
    used += sep + block.length;
  }

  return {
    text: rendered.join("\n"),
    terms,
    slideNumber,
    figureIndex,
  };
}

/**
 * Generic grounding audit. No domain lists — a term is allowed only if its exact
 * string (or every significant token of it) came from the figure data/context.
 */
export function auditExplanation({ explanation = "", evidence = [], labels = [], context } = {}) {
  const terms = context?.terms ?? [];
  const corpus = new Set(terms.map(normalizeTerm).filter(Boolean));
  const corpusTokens = new Set();
  for (const t of corpus) for (const tok of t.split(/\s+/)) if (tok.length >= 3) corpusTokens.add(tok);
  const text = normalizeTerm(context?.text ?? "") + " " + [...corpus].join(" ");

  const isGrounded = (value) => {
    const n = normalizeTerm(value);
    if (!n) return false;
    if (corpus.has(n) || text.includes(n)) return true;
    const tokens = n.split(/\s+/).filter((tok) => tok.length >= 3 && !STOPWORDS.has(tok));
    if (!tokens.length) return false;
    return tokens.every((tok) => corpusTokens.has(tok) || text.includes(tok));
  };

  const allClaims = [...(evidence ?? []), ...(labels ?? [])].map((v) => String(v));
  const ungrounded = [...new Set(allClaims.filter((v) => !isGrounded(v)))];
  const grounded = [...new Set(allClaims.filter(isGrounded))];

  // Catch domain terms that appear in the prose but were never declared as labels.
  const properNouns = String(explanation ?? "").match(/\b[A-Z][\w&/-]*(?:\s+[A-Z][\w&/-]*)*\b/g) ?? [];
  const flaggedProperNouns = [...new Set(properNouns.filter((v) => {
    const n = normalizeTerm(v);
    if (n.length <= 2) return false;
    const significant = n.split(/\s+/).filter((tok) => tok.length >= 3 && !STOPWORDS.has(tok));
    if (significant.length === 0) return false; // e.g. "The Figure" — all stopwords
    return !isGrounded(v);
  }))];

  return {
    ok: ungrounded.length === 0 && flaggedProperNouns.length === 0,
    ungrounded,
    grounded,
    flaggedProperNouns,
  };
}
