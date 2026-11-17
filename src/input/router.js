// src/input/router.js
// §2 — Per-page routing (text-layer vs VLM).

import { config } from "../config.js";

export function routePages(analysis, { forceVlm = false } = {}) {
  return (analysis?.pages ?? []).map((p) => {
    if (forceVlm) return { ...p, route: "vlm" };
    // Prefer text_chars_total (ALL text incl. table-cell spans, computed by the
    // worker as reporting metadata). text_chars excludes table spans by design,
    // so a pure table page would otherwise route to the VLM despite being
    // born-digital. Falls back to text_chars when the total is unavailable.
    const textChars = p.text_chars_total ?? p.text_chars ?? 0;
    const hasText = textChars >= config.minCharsForTextLayer;
    const imageDominant = (p.image_cover_frac ?? 0) >= config.imageCoverForceVlm;
    return { ...p, route: hasText && !imageDominant ? "text-layer" : "vlm" };
  });
}
