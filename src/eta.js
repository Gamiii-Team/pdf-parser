// src/eta.js — ETA estimate for the async vlm analysis phase.
// Linear extrapolation from slides completed vs wall-clock time since start.
// Deliberately conservative: null until the rate is stable enough to trust.

const ETA_MIN_SAMPLES = 3;      // slides completed before a rate exists
const ETA_MIN_ELAPSED_MS = 20_000;
const ETA_MAX_MS = 2 * 60 * 60 * 1000;

export function etaFor({ done, total, startedAt, now = Date.now() } = {}) {
  if (typeof done !== "number" || typeof total !== "number") return null;
  if (!(total > 0) || done <= 0) return null;       // unknown total or nothing done yet
  if (done >= total) return 0;
  if (typeof startedAt !== "number") return null;
  const elapsed = now - startedAt;
  if (elapsed <= 0) return null;
  if (done < ETA_MIN_SAMPLES && elapsed < ETA_MIN_ELAPSED_MS) return null; // cold start
  const rate = done / elapsed;                        // slides per ms
  const etaMs = (total - done) / rate;
  return Math.min(Math.max(Math.round(etaMs / 5000) * 5000, 0), ETA_MAX_MS);
}

export function formatEtaMs(ms) {
  if (ms == null) return "estimating…";
  if (ms <= 0) return "done";
  const s = Math.round(ms / 1000);
  if (s < 60) return `~${s} s left`;
  const m = Math.round(s / 60);
  if (m < 60) return `~${m} min left`;
  const h = Math.floor(m / 60);
  return `~${h} h ${m % 60} min left`;
}
