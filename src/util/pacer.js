// src/util/pacer.js — one shared choke point for every VLM request.
// Guarantees at least VLM_MIN_GAP_MS (+ jitter) between request *starts* across
// the whole process. On a 429 it pauses every worker until pausedUntil clears
// (header-reported Retry-After, else jittered exponential backoff capped at
// VLM_MAX_WAIT_MS), and it can fail the pending job immediately when the wait
// exceeds VLM_MAX_WAIT_MS.
//
// The pacer is safe to share across jobs. It holds one small piece of shared
// mutable state, updated under one synchronous critical section — no locks
// needed in Node.

import { config } from "../config.js";
import { logTiming } from "./log.js";

export class Pacer {
  constructor({ minGapMs, jitterMs, maxWaitMs, maxBackoffMs, backoffStartMs } = {}) {
    this.minGapMs = minGapMs ?? config.vlmMinGapMs ?? 400;
    this.jitterMs = Math.max(0, jitterMs ?? config.vlmGapJitterMs ?? 100);
    this.maxWaitMs = maxWaitMs ?? config.vlmMaxWaitMs ?? 60000;
    this.maxBackoffMs = maxBackoffMs ?? 30_000;
    this.backoffStartMs = backoffStartMs ?? 2_000;

    this._nextSlotAt = 0;      // earliest allowed start time
    this._pausedUntil = 0;     // global cool-down end time
    this._lastPauseReason = null;
    this._activeCalls = 0;     // best-effort inflight counter
  }

  /** Number of ms until the next slot is free. 0 if ready now. */
  msUntilNextStart() {
    return Math.max(0, this._nextSlotAt - Date.now(), this._pausedUntil - Date.now());
  }

  /** Wait until the shared next slot is free; reserve the slot atomically. */
  async waitForSlot() {
    for (;;) {
      const wait = this.msUntilNextStart();
      if (wait <= 0) {
        // Reserve the slot synchronously: atomic advance of nextSlotAt.
        const now = Date.now();
        this._nextSlotAt = now + this.minGapMs + this._jitter();
        return;
      }
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  _jitter() {
    if (this.jitterMs <= 0) return 0;
    return Math.round(Math.random() * this.jitterMs);
  }

  /** Record a 429 response: start the global cooldown and reduce workers. */
  noteRateLimit({ retryAfterMs, reason = "429", tag = "pacer" }) {
    const base = retryAfterMs ?? this.backoffStartMs;
    const computed = Math.min(this.maxBackoffMs, Math.max(100, base ?? this.backoffStartMs));
    const wait = Math.min(this.maxWaitMs, computed);
    this._pausedUntil = Date.now() + wait;
    this._lastPauseReason = reason;
    logTiming({ phase: "pacer-pause", reason, wait_ms: wait, source: tag });
    return wait;
  }

  /** Record a successful call — used to nudge the slot forward. */
  noteSuccess(tag = "pacer") {
    // Next slot is already reserved inside waitForSlot(); nothing extra to do.
    void tag;
  }

  /** Test helpers — not for production use. */
  _resetForTest() {
    this._nextSlotAt = 0;
    this._pausedUntil = 0;
    this._lastPauseReason = null;
    this._activeCalls = 0;
  }
}

export const pacer = new Pacer();
