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

/** Process-wide timing sink. Logs one structured entry per VLM call for later tuning. */
const timingLines = [];
export function logTiming(entry) {
  const line = { t: Date.now(), ...entry };
  timingLines.push(line);
  // Keep the last N entries only to bound memory.
  if (timingLines.length > 2000) timingLines.shift();
  return line;
}

/** Read the most-recent timing entries (for report surfacing). */
export function recentTimings() {
  return timingLines.slice(-500);
}

/** Best-effort timing: logs the duration and rethrows the original error. */
export async function timed(label, fn, extra) {
  const t0 = Date.now();
  try {
    const out = await fn();
    logTiming({ label, ms: Date.now() - t0, ok: true, ...(extra ? { extra } : {}) });
    return out;
  } catch (err) {
    logTiming({ label, ms: Date.now() - t0, ok: false, error: String(err?.message ?? err).slice(0, 200), ...(extra ? { extra } : {}) });
    throw err;
  }
}
