// src/util/retry.js
// Retry with exponential backoff and jitter. Handles HTTP 429 and 5xx responses
// carrying a `status` property, plus network errors. Honors Retry-After when present.

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {() => Promise<T>} fn
 * @param {{ retries?: number, baseMs?: number, maxMs?: number, label?: string, onRetry?: (info: object) => void, shouldRetry?: (err: any) => boolean }} opts
 * @returns {Promise<T>}
 */
export async function withRetry(fn, opts = {}) {
  const {
    retries = 6,
    baseMs = 1000,
    maxMs = 60_000,
    label = "request",
    onRetry = () => {},
    shouldRetry = (err) => err?.retryable === true || isRetryableHttp(err),
  } = opts;

  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !shouldRetry(err)) throw err;
      attempt += 1;
      const retryAfterMs = err?.retryAfterMs ?? null;
      const backoff = retryAfterMs ?? Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      const jitter = Math.round(backoff * 0.25 * (Math.random() * 2 - 1)); // +/- 25%
      const wait = Math.max(250, backoff + jitter);
      onRetry({ attempt, waitMs: wait, label, error: err?.message ?? String(err) });
      await sleep(wait);
    }
  }
}

function isRetryableHttp(err) {
  const status = err?.status;
  if (typeof status !== "number") return false;
  return status === 429 || (status >= 500 && status < 600);
}

/** Wrap a fetch Response-like error with status + Retry-After parsing. */
export async function httpErrorFromResponse(resp, bodySnippet = "") {
  const status = resp.status;
  const retryAfterHeader = resp.headers?.get?.("retry-after");
  let retryAfterMs = null;
  if (retryAfterHeader) {
    const secs = Number(retryAfterHeader);
    if (Number.isFinite(secs)) retryAfterMs = secs * 1000;
    else {
      const ts = Date.parse(retryAfterHeader);
      if (!Number.isNaN(ts)) retryAfterMs = Math.max(0, ts - Date.now());
    }
  }
  const err = new Error(`HTTP ${status}${bodySnippet ? `: ${bodySnippet}` : ""}`);
  err.status = status;
  err.retryAfterMs = retryAfterMs;
  err.retryable = status === 429 || (status >= 500 && status < 600);
  return err;
}
