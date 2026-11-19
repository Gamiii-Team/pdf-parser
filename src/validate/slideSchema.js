// src/validate/slideSchema.js — per-slide JSON schema validation + native cross-check.
// Hand-rolled (no new deps). Used by the full-VLM PPTX mode.

const ROLES = new Set(["heading", "body", "bullet", "caption", "footer", "note"]);
const FIGURE_TYPES = new Set(["chart", "image", "diagram", "logo", "icon", "screenshot"]);
const CONFIDENCE = new Set(["high", "medium", "low"]);
const BBOX_SOURCES = new Set(["native", "model", "reviewer"]);
const MIN_BOX = 0.02;

const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string";
const isStrOrNull = (v) => v === null || isStr(v);

function checkStringArray(v, field, errors, { allowEmpty = true } = {}) {
  if (!Array.isArray(v)) { errors.push(`${field} must be an array`); return; }
  for (const [i, item] of v.entries()) {
    if (!isStr(item)) errors.push(`${field}[${i}] must be a string`);
  }
  if (!allowEmpty && v.length === 0) errors.push(`${field} must not be empty`);
}

function checkFigureBox(f, i, errors) {
  const box = f.bbox;
  if (box === undefined) return;
  if (!Array.isArray(box) || box.length !== 4 || box.some((v) => typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1)) {
    errors.push(`figures[${i}].bbox must be [x0, y0, x1, y1] with each value in [0, 1]`);
    return;
  }
  const [x0, y0, x1, y1] = box;
  if (!(x1 > x0 && y1 > y0)) errors.push(`figures[${i}].bbox must have x1 > x0 and y1 > y0`);
  if (x1 - x0 < MIN_BOX || y1 - y0 < MIN_BOX) errors.push(`figures[${i}].bbox is smaller than the ${MIN_BOX * 100}% minimum size`);
}

function checkFigureSource(f, i, errors) {
  if (f.bbox_source !== undefined && !BBOX_SOURCES.has(String(f.bbox_source))) {
    errors.push(`figures[${i}].bbox_source must be one of native, model, reviewer`);
  }
  if (f.bbox_locked !== undefined && typeof f.bbox_locked !== "boolean") {
    errors.push(`figures[${i}].bbox_locked must be a boolean`);
  }
  if (f.structure !== undefined) {
    if (!Array.isArray(f.structure)) errors.push(`figures[${i}].structure must be an array of strings`);
    else for (const [s, item] of f.structure.entries()) {
      if (!isStr(item)) errors.push(`figures[${i}].structure[${s}] must be a string`);
    }
  }
}

export function validateSlide(obj, { expectedSlide } = {}) {
  const errors = [];
  if (!isObj(obj)) return { ok: false, errors: ["slide JSON must be an object"] };

  if (!Number.isInteger(obj.slide) || obj.slide < 1) errors.push("slide must be a positive integer");
  else if (expectedSlide != null && obj.slide !== expectedSlide) errors.push(`slide is ${obj.slide}, expected ${expectedSlide}`);

  if (obj.title !== undefined && !isStrOrNull(obj.title)) errors.push("title must be string|null");
  if (obj.subtitle !== undefined && !isStrOrNull(obj.subtitle)) errors.push("subtitle must be string|null");

  if (obj.text_blocks !== undefined) {
    if (!Array.isArray(obj.text_blocks)) errors.push("text_blocks must be an array");
    else for (const [i, b] of obj.text_blocks.entries()) {
      if (!isObj(b)) { errors.push(`text_blocks[${i}] must be an object`); continue; }
      if (!isStr(b.text) || !b.text.trim()) errors.push(`text_blocks[${i}].text must be a non-empty string`);
      if (b.role !== undefined && !ROLES.has(String(b.role))) errors.push(`text_blocks[${i}].role "${b.role}" is not one of ${[...ROLES].join(", ")}`);
      if (b.level !== undefined && (typeof b.level !== "number" || !Number.isFinite(b.level) || b.level < 0)) errors.push(`text_blocks[${i}].level must be a number >= 0`);
    }
  }

  if (obj.tables !== undefined) {
    if (!Array.isArray(obj.tables)) errors.push("tables must be an array");
    else for (const [i, t] of obj.tables.entries()) {
      if (!isObj(t)) { errors.push(`tables[${i}] must be an object`); continue; }
      checkStringArray(t.headers ?? [], `tables[${i}].headers`, errors);
      if (!Array.isArray(t.rows)) { errors.push(`tables[${i}].rows must be an array of string arrays`); continue; }
      for (const [r, row] of t.rows.entries()) checkStringArray(row, `tables[${i}].rows[${r}]`, errors);
    }
  }

  if (obj.figures !== undefined) {
    if (!Array.isArray(obj.figures)) errors.push("figures must be an array");
    else for (const [i, f] of obj.figures.entries()) {
      if (!isObj(f)) { errors.push(`figures[${i}] must be an object`); continue; }
      if (!FIGURE_TYPES.has(String(f.type))) errors.push(`figures[${i}].type "${f.type}" is not one of ${[...FIGURE_TYPES].join(", ")}`);
      if (f.title !== undefined && !isStrOrNull(f.title)) errors.push(`figures[${i}].title must be string|null`);
      if (!isStr(f.description) || !f.description.trim()) errors.push(`figures[${i}].description must be a non-empty string`);
      if (f.data !== undefined) {
        if (!isObj(f.data)) { errors.push(`figures[${i}].data must be an object`); }
        else {
          if (f.data.labels !== undefined) checkStringArray(f.data.labels, `figures[${i}].data.labels`, errors);
          if (f.data.series !== undefined) {
            if (!Array.isArray(f.data.series)) errors.push(`figures[${i}].data.series must be an array`);
            else for (const [s, sr] of f.data.series.entries()) {
              if (!isObj(sr)) { errors.push(`figures[${i}].data.series[${s}] must be an object`); continue; }
              if (!isStr(sr.name)) errors.push(`figures[${i}].data.series[${s}].name must be a string`);
              if (!Array.isArray(sr.values) || sr.values.some((v) => typeof v !== "number" || !Number.isFinite(v))) {
                errors.push(`figures[${i}].data.series[${s}].values must be an array of finite numbers`);
              }
            }
          }
        }
      }
      if (f.visible_text !== undefined) checkStringArray(f.visible_text, `figures[${i}].visible_text`, errors);
      checkFigureBox(f, i, errors);
      checkFigureSource(f, i, errors);
      if (f.excluded !== undefined && typeof f.excluded !== "boolean") errors.push(`figures[${i}].excluded must be a boolean`);
      if (f.reviewer_note !== undefined && typeof f.reviewer_note !== "string") errors.push(`figures[${i}].reviewer_note must be a string`);
    }
  }

  if (obj.speaker_notes !== undefined && !isStrOrNull(obj.speaker_notes)) errors.push("speaker_notes must be string|null");
  if (obj.confidence !== undefined && !CONFIDENCE.has(String(obj.confidence))) errors.push(`confidence must be one of high, medium, low`);
  if (obj.issues !== undefined) checkStringArray(obj.issues, "issues", errors);

  return { ok: errors.length === 0, errors };
}

/** Validate only the figures array — used by the re-run endpoint. */
export function validateFigures(figures) {
  const errors = [];
  if (figures === undefined) return { ok: true, errors };
  if (!Array.isArray(figures)) return { ok: false, errors: ["figures must be an array"] };
  for (const [i, f] of figures.entries()) {
    if (!isObj(f)) { errors.push(`figures[${i}] must be an object`); continue; }
    if (!FIGURE_TYPES.has(String(f.type))) errors.push(`figures[${i}].type "${f.type}" is not one of ${[...FIGURE_TYPES].join(", ")}`);
    if (f.title !== undefined && !isStrOrNull(f.title)) errors.push(`figures[${i}].title must be string|null`);
    if (!isStr(f.description) || !f.description.trim()) errors.push(`figures[${i}].description must be a non-empty string`);
    if (f.data !== undefined) {
      if (!isObj(f.data)) errors.push(`figures[${i}].data must be an object`);
      else {
        if (f.data.labels !== undefined) checkStringArray(f.data.labels, `figures[${i}].data.labels`, errors);
        if (f.data.series !== undefined) {
          if (!Array.isArray(f.data.series)) errors.push(`figures[${i}].data.series must be an array`);
          else for (const [s, sr] of f.data.series.entries()) {
            if (!isObj(sr)) { errors.push(`figures[${i}].data.series[${s}] must be an object`); continue; }
            if (!isStr(sr.name)) errors.push(`figures[${i}].data.series[${s}].name must be a string`);
            if (!Array.isArray(sr.values) || sr.values.some((v) => typeof v !== "number" || !Number.isFinite(v))) {
              errors.push(`figures[${i}].data.series[${s}].values must be an array of finite numbers`);
            }
          }
        }
      }
    }
    if (f.visible_text !== undefined) checkStringArray(f.visible_text, `figures[${i}].visible_text`, errors);
    checkFigureBox(f, i, errors);
    checkFigureSource(f, i, errors);
  }
  return { ok: errors.length === 0, errors };
}

/** Validate only the tables array — used by the re-run endpoint. */
export function validateTables(tables) {
  const errors = [];
  if (tables === undefined) return { ok: true, errors };
  if (!Array.isArray(tables)) return { ok: false, errors: ["tables must be an array"] };
  for (const [i, t] of tables.entries()) {
    if (!isObj(t)) { errors.push(`tables[${i}] must be an object`); continue; }
    checkStringArray(t.headers ?? [], `tables[${i}].headers`, errors);
    if (!Array.isArray(t.rows)) { errors.push(`tables[${i}].rows must be an array of string arrays`); continue; }
    for (const [r, row] of t.rows.entries()) checkStringArray(row, `tables[${i}].rows[${r}]`, errors);
  }
  return { ok: errors.length === 0, errors };
}

/** Strip review-only fields from a full result doc for export. Untrusted output for humans. */
export function stripReviewOnly(resultDoc) {
  const slides = (resultDoc?.slides ?? []).map((slide) => {
    if (!isObj(slide)) return slide;
    const { previous, reviewed, rerun_count, rerunCount, ...rest } = slide;
    const figures = (Array.isArray(rest.figures) ? rest.figures : [])
      .filter((f) => !f?.excluded)
      .map((f) => { const { excluded, reviewer_note, bbox, bbox_source, bbox_locked, ...keep } = f; return keep; });
    return { ...rest, figures };
  });
  return { ...resultDoc, slides };
}

/** Compare the VLM's figure values against the deck's native chart hints. */
export function crossCheckSlide(slideJson, hint) {
  const notes = [];
  const nativeValues = [];
  for (const chart of hint?.charts ?? []) {
    for (const sr of chart?.series ?? []) {
      for (const v of sr?.values ?? []) if (typeof v === "number" && Number.isFinite(v)) nativeValues.push(v);
    }
  }
  if (nativeValues.length === 0) return { confidence: slideJson.confidence ?? "medium", issues: [] };
  for (const fig of slideJson.figures ?? []) {
    for (const sr of fig?.data?.series ?? []) {
      for (const v of sr?.values ?? []) {
        if (typeof v !== "number" || !Number.isFinite(v)) continue;
        const ok = nativeValues.some((n) => Math.abs(n - v) < 1e-6);
        if (!ok) notes.push(`figure value ${v} not present in native chart data (${JSON.stringify(nativeValues)})`);
      }
    }
  }
  if (notes.length === 0) return { confidence: slideJson.confidence ?? "medium", issues: [] };
  return {
    confidence: "low",
    issues: notes.slice(0, 10),
  };
}
