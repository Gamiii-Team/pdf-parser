// UI/js/labels.js — turn opaque review flags ("failed", "low", "issues ×N")
// into labels that say what actually happened. Pure functions, no DOM, so the
// same logic is unit-testable in node:test.
//
// Input is the per-slide JSON produced by the VLM path:
//   slide.failed      — boolean, the slide never produced usable output
//   slide.confidence  — "high" | "medium" | "low"
//   slide.issues      — string[] with the raw reason (cross-check notes,
//                       pass failures, zoom unreadables, provider errors…)
//   figure.notes      — per-figure note, e.g. "figure_pass_failed: …"

const RULES = [
  { re: /^slide analysis failed/i, kind: "vlm", short: "VLM analysis failed" },
  { re: /^figure_pass_failed/i, kind: "figure-pass", short: "figure pass failed" },
  { re: /not present in native chart data/i, kind: "value-mismatch", short: "value not in native chart data" },
  { re: /^zoom:.*tile\(s\) unreadable/i, kind: "zoom", short: "zoom tiles unreadable" },
  { re: /native hints unavailable/i, kind: "hints", short: "native hints misaligned" },
  { re: /schema validation failed/i, kind: "schema", short: "schema validation failed" },
  { re: /provider|rate limit|quota|timeout|429|5\d{2}/i, kind: "provider", short: "provider error" },
];

const FALLBACK = { kind: "issue", short: "issue" };

export function categorizeIssue(text) {
  if (typeof text !== "string" || !text.trim()) return { ...FALLBACK, short: "empty issue" };
  for (const rule of RULES) if (rule.re.test(text)) return { kind: rule.kind, short: rule.short };
  return { ...FALLBACK };
}

export function summarizeSlide(slide) {
  const issues = Array.isArray(slide?.issues)
    ? slide.issues.filter((i) => typeof i === "string" && i.trim())
    : [];
  const failed = slide?.failed === true;
  const low = (slide?.confidence ?? "medium") === "low";
  const mismatches = issues.filter((i) => /not present in native chart data/i.test(i)).length;

  return {
    failed: failed
      ? {
          short: issues.length ? categorizeIssue(issues[0]).short : "analysis failed",
          detail: issues[0] ?? "slide failed without a recorded reason",
        }
      : null,
    low: low
      ? {
          short: mismatches
            ? `low confidence · ${mismatches} value mismatch${mismatches === 1 ? "" : "es"}`
            : "low confidence",
          detail: issues.join("\n") || "model marked this slide low confidence",
        }
      : null,
    issues: issues.map((text) => ({ ...categorizeIssue(text), detail: text })),
  };
}

// Badges for the left rail. `text` stays short (rail is narrow); the full
// reason travels in the native `title` tooltip.
export function badgeLabels(slide) {
  const sum = summarizeSlide(slide);
  const out = [];
  if (sum.failed) out.push({ cls: "badge failed", text: `✕ ${sum.failed.short}`, title: sum.failed.detail });
  if (sum.low) out.push({ cls: "badge low", text: sum.low.short, title: sum.low.detail });
  if (sum.issues.length) {
    out.push({
      cls: "badge issues",
      text: `⚠ ${sum.issues.length} issue${sum.issues.length === 1 ? "" : "s"}`,
      title: sum.issues.map((i) => i.detail).join("\n"),
    });
  }
  return out;
}

export function figureNoteLabel(note) {
  if (typeof note !== "string" || !note.trim()) return null;
  const { kind, short } = categorizeIssue(note);
  return { kind, short, detail: note };
}
