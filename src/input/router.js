// src/input/router.js
// §2 — Per-page routing (text-layer vs VLM).

import { config } from "../config.js";

export function routePages(analysis, { forceVlm = false } = {}) {
  return (analysis?.pages ?? []).map((p) => {
    if (forceVlm) return { ...p, route: "vlm" };
    const hasText = (p.text_chars ?? 0) >= config.minCharsForTextLayer;
    const imageDominant = (p.image_cover_frac ?? 0) >= config.imageCoverForceVlm;
    return { ...p, route: hasText && !imageDominant ? "text-layer" : "vlm" };
  });
}
