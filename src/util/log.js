// src/util/log.js
// Tiny structured logger. Keeps stdout clean-ish and gives the run report a
// machine-readable sibling.

export function createLogger({ silent = false } = {}) {
  const lines = [];
  function log(level, msg, extra) {
    const entry = { level, msg, ...(extra ? { extra } : {}) };
    lines.push(entry);
    if (!silent) {
      const prefix = level === "error" ? "❌" : level === "warn" ? "⚠️" : level === "debug" ? "🔧" : "ℹ️";
      console.log(`${prefix} ${msg}`);
    }
  }
  return {
    info: (m, x) => log("info", m, x),
    warn: (m, x) => log("warn", m, x),
    error: (m, x) => log("error", m, x),
    debug: (m, x) => log("debug", m, x),
    lines,
  };
}

/** Approximate token count: ~4 characters per token (documented, not exact). */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}
