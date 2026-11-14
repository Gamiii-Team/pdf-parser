// src/util/token.js
// Token estimation shared by the chunker and the run report.

/** ~4 characters per token (documented approximation; matches common practice). */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

/** Compose the search/embedding-oriented text rendering of a single element. */
export function elementToText(el) {
  switch (el.type) {
    case "heading": {
      const level = Math.min(Math.max(el.level ?? 1, 1), 6);
      return `${"#".repeat(level)} ${el.text}`;
    }
    case "paragraph":
    case "list":
    case "code":
    case "equation":
    case "caption":
      return el.text ?? "";
    case "table":
      return el.text ?? ""; // already a markdown table from the factory
    case "figure": {
      const bits = [];
      bits.push(`[Figure${el.figure_type ? ` (${el.figure_type})` : ""}]`);
      if (el.caption) bits.push(`Caption: ${el.caption}`);
      if (el.description) bits.push(`Description: ${el.description}`);
      if (el.data) {
        const dataText = summarizeFigureData(el.data);
        if (dataText) bits.push(`Data: ${dataText}`);
      }
      if (el.error) bits.push(`(figure analysis error: ${el.error})`);
      return bits.join("\n");
    }
    default:
      return el.text ?? "";
  }
}

/** Compact one-line summary of a figure's structured data. */
export function summarizeFigureData(data) {
  if (!data || typeof data !== "object") return "";
  const parts = [];
  if (Array.isArray(data.x) && Array.isArray(data.series)) {
    for (const s of data.series) {
      const values = Array.isArray(s?.values) ? s.values.map((v) => (typeof v === "number" ? v : Number.NaN)) : [];
      const joined = values.every(Number.isFinite) ? values.join(",") : values.join(",");
      parts.push(`${s?.name ?? "series"}: [${joined}]${data.estimates ? " (estimates)" : ""}`);
    }
    if (data.x.length) parts.push(`x=[${data.x.join(",")}]`);
  } else if (Array.isArray(data.nodes) && Array.isArray(data.edges)) {
    const nodeText = data.nodes.map((n) => `${n?.id ?? "?"}:${n?.label ?? ""}`).join(" | ");
    const edgeText = data.edges.map((e) => `${e?.from ?? e?.source ?? "?"}->${e?.to ?? e?.target ?? "?"}`).join(" | ");
    parts.push(`nodes: ${nodeText}`);
    parts.push(`edges: ${edgeText}`);
  } else {
    const compact = JSON.stringify(data);
    parts.push(compact.length > 300 ? `${compact.slice(0, 300)}…` : compact);
  }
  return parts.join("; ");
}

export function elementTokenEstimate(el) {
  return estimateTokens(elementToText(el));
}
