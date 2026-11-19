// src/mergeMain.js — queue computation and atomic main.json rebuild.
// The review page edits only { figures, tables } per slide; everything else
// comes from the first pass unchanged. main.json is the deliverable and is
// rewritten atomically (temp file + rename) every time merged state changes.

import fs from "node:fs";
import path from "node:path";

const REVIEW_ONLY = ["excluded", "reviewer_note", "bbox", "bbox_source", "bbox_locked", "previous", "reviewed", "rerun_count", "rerunCount", "rerunStatus"];

/** Has a picture / chart / table on the slide per the native hints for that page. */
function hintHasObject(hint) {
  if (!hint) return false;
  return (hint.pictures?.length ?? 0) > 0 || (hint.tables?.length ?? 0) > 0 || (hint.charts?.length ?? 0) > 0;
}

/** Decide which slides belong in the review queue. */
export function computeQueue(slides, hints) {
  const hintsAttach = hints && slides.length > 0 && hints.length === slides.length;
  const queued = [], auto = [], failed = [];
  for (let i = 0; i < slides.length; i++) {
    const s = slides[i];
    const hint = hintsAttach ? hints[i] : null;
    const hasFigures = Array.isArray(s.figures) && s.figures.length > 0;
    const hasTables = Array.isArray(s.tables) && s.tables.length > 0;
    const isFailed = Boolean(s.failed);
    if (isFailed || hasFigures || hasTables || hintHasObject(hint)) {
      queued.push(s.slide);
      if (isFailed) failed.push(s.slide);
    } else {
      auto.push(s.slide);
    }
  }
  return { queued, auto, failed };
}

/** Review-only fields are stripped from every figure. Excluded figures are dropped. */
function stripFigures(figures) {
  return (Array.isArray(figures) ? figures : [])
    .filter((f) => !f?.excluded)
    .map((f) => {
      const cleaned = { ...f };
      for (const key of REVIEW_ONLY) delete cleaned[key];
      return cleaned;
    });
}

function stripTables(tables) {
  return Array.isArray(tables) ? tables.map((t) => ({ ...t })) : [];
}

/**
 * Build the final main.json document from a result.json document.
 * Review-only fields are removed everywhere; excluded figures are dropped;
 * slides not yet approved carry review_status "pending"; failed slides carry failed:true.
 */
export function mergeSlides(result, statuses) {
  const statusMap = statuses ?? {};
  const slidesOut = (Array.isArray(result?.slides) ? result.slides : []).map((slide) => {
    const n = slide?.slide;
    if (slide?.failed) {
      return { slide: n ?? null, failed: true, issues: slide.issues ?? ["slide analysis failed"], confidence: "low" };
    }
    const status = statusMap[n] ?? null;
    const reviewStatus = status === "approved" ? undefined : status === "auto" ? undefined : "pending";
    const base = { ...slide };
    delete base.failed;
    delete base.reviewed;
    delete base.rerun_count;
    delete base.confidence_check;
    delete base.previous;
    const merged = {
      ...base,
      figures: stripFigures(slide.figures),
      tables: stripTables(slide.tables),
    };
    if (reviewStatus) merged.review_status = reviewStatus;
    return merged;
  });
  return {
    jobId: result?.jobId ?? null,
    mode: result?.mode ?? "vlm",
    model: result?.model ?? null,
    backend: result?.backend ?? "groq",
    input: result?.input ?? "unknown.pptx",
    created: result?.created ?? null,
    slides: slidesOut,
  };
}

/** Write main.json atomically: temp file in the same folder, then rename. */
export function writeMainAtomic(outDir, main) {
  const target = path.join(outDir, "main.json");
  const temp = path.join(outDir, `.main.json.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(temp, JSON.stringify(main, null, 2));
  fs.renameSync(temp, target);
  return target;
}

/** Read the in-memory artifacts (outDir) → { result, status }. */
export function readArtifacts(outDir) {
  const result = (() => { try { return JSON.parse(fs.readFileSync(path.join(outDir, "result.json"), "utf8")); } catch { return null; } })();
  const status = (() => { try { return JSON.parse(fs.readFileSync(path.join(outDir, "status.json"), "utf8")); } catch { return null; } })();
  return { result, status };
}

/** Stamp the derived queue statuses into status.json. */
export function buildStatusSlideMap(slides, hints) {
  const { queued, auto, failed } = computeQueue(slides, hints);
  const map = {};
  for (const n of auto) map[n] = "auto";
  for (const n of queued) map[n] = "queued";
  for (const n of failed) map[n] = "failed";
  return map;
}
