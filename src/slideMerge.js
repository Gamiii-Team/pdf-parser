// src/slideMerge.js — apply a re-run result to one slide (figures/tables only).
// Kept separate from the UI server so both the HTTP handler and the unit tests
// exercise the same code path.

import { crossCheckSlide } from "./validate/slideSchema.js";

/**
 * Merge a re-run result into a slide.
 * - Reviewer-anchored items (excluded: not a figure, or bbox_locked: box frozen) are kept verbatim.
 * - Everything else in the slide is untouched.
 * - Only figures and tables come from the new result; `previous` stores the old pair.
 * - Confidence is re-derived from the native hints cross-check.
 */
export function applyRerun(slide, { figures, tables }, hint) {
  const anchored = (slide?.figures ?? []).filter((f) => f?.excluded || f?.bbox_locked);
  const previous = { figures: slide?.figures ?? [], tables: slide?.tables ?? [] };
  const merged = {
    ...slide,
    figures: [...anchored, ...(Array.isArray(figures) ? figures : [])],
    tables: Array.isArray(tables) ? tables : [],
    confidence: "medium",
    issues: [],
    reviewed: false,
    failed: false,
    previous,
    rerun_count: Number(slide?.rerun_count ?? 0) + 1,
  };
  const check = crossCheckSlide(merged, hint);
  merged.confidence = check.confidence;
  merged.issues = [...(merged.issues ?? []), ...(check.issues ?? [])];
  return merged;
}

/** Undo the last re-run by popping the `previous` pair. */
export function undoRerun(slide) {
  const previous = slide?.previous;
  if (!previous || !Array.isArray(previous.figures)) return null;
  const { previous: _drop, rerun_count, ...rest } = slide;
  return {
    ...rest,
    figures: previous.figures,
    tables: Array.isArray(previous.tables) ? previous.tables : (rest.tables ?? []),
    rerun_count: Math.max(0, Number(rerun_count ?? 1) - 1),
    reviewed: false,
  };
}
