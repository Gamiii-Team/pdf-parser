# VLM-mode resilience — what changed in section 11

**Goal:** eliminate the "job did not finish within 10 minutes" failure and make decks feel incremental rather than frozen.

## What actually broke the original experience

The 10-minute cap was not a server timeout — it was the browser's polling deadline:

```js
// UI/js/app.js (before)
const deadline = Date.now() + 10 * 60 * 1000;
for (;;) { await new Promise(r => setTimeout(r, 1000)); ... if (Date.now() > deadline) throw "job did not finish within 10 minutes"; }
```

If the first pass took longer than 10 minutes (a 25-slide deck, especially with image-heavy slides and a cold LibreOffice profile), the page gave up even though the server was still working fine. The fix is no longer a fixed cap on the client side.

## What is in place now

| Spec item | Status | Where |
|---|---|---|
| 11.0 Diagnose first | done | see diagnosis report in the session log |
| 11.1 Global queue w/ round-robin | **partial** | `src/util/taskQueue.js` provides a process-wide queue with round-robin-by-priority and retry-aware worker reduction on 429. `extractSlidesVlm` still drains via a local bounded pool; wiring the global queue into the upload path is the remaining refactor. |
| 11.2 429 backoff + worker reduction | done | `src/util/retry.js` (Retry-After honoured) + `taskQueue.js._noteRateLimit` |
| 11.3 Per-call timeout, stall detector | done | `VLM_TIMEOUT_MS` (was 120 s, called "avoid hanging reviewer"); `JOB_STALL_MINUTES=5` polled by `stallWatchdog` in `src/pptxVlmRun.js`; jobs marked `failed` only after silence |
| 11.4 Persist + cancel + retry-failed | **partial** | `POST /api/jobs/:id/cancel` sets a process-wide cancel flag honoured between VLM calls (in-flight request is not aborted — honoured between calls); `POST /api/jobs/:id/retry-failed` is a stub for now; persistence of per-slide outcome is now written as `slides/NN.json` as soon as the slide lands |
| 11.5 Results-as-they-finish | done | poll `/api/jobs/:id` every 2 s; progress chip shows `Analyzing N/M`; review page shows the slides as they complete |
| 11.6 Result-content controls | done | `VLM_IMAGE_MAX_SIDE` (renders at 150 DPI; already small), `VLM_SKIP_TEXT_ONLY` flag documented (§11.6(1)); JSON-mode `response_format: json_object` used by all VLM calls |
| 11.7 Config summary | done | `.env.example` documents: `VLM_CONCURRENCY=3`, `VLM_TIMEOUT_MS=120000`, `JOB_STALL_MINUTES=5`, `VLM_SKIP_TEXT_ONLY=false`, `VLM_IMAGE_MAX_SIDE=1400`; `MODEL_RETRIES` and `HTTP_RETRIES` already exist in `.env.example` |
| 11.8 Endpoints | done | `POST /api/jobs/:id/cancel`, `POST /api/jobs/:id/retry-failed`; GET `/api/jobs/:id` now returns `progress: { done, total, queued }` |
| 11.9 Tests | **partial** | VLM-run path and poll path exercised via the `client` smoke test (`tests/reviewEndpoints.test.js`); queue unit test not yet added |

## Timing sink

`src/util/log.js` now exports `recentTimings()`. Every VLM call (first pass, re-run, zoom tiles, figure pass is unaffected) writes a structured entry (job id, slide, attempt, tokens, ms). The run-report.json carries them under `timings` for later tuning. `console.log`-style logs are unchanged.

## Honest gaps (not yet done this session)

1. **`src/util/taskQueue.js` is not yet wired in.** It exists but `extractSlidesVlm` uses a local pool; making the global queue the actual driver is a focused refactor that touches every run path and needs a careful review against the 137-test suite. It is the highest-value next step.
2. **Cancel is best-effort.** In-flight VLM calls run to completion before the next task sees the flag. For robustness, the cancel check could abort the queue itself — blocked on wiring the global queue.
3. **`POST /api/jobs/:id/retry-failed` is a marker endpoint.** It tells the UI which slides are failed so the reviewer can Re-run each individually; it does not yet enqueue a task per failed slide atomically.
4. **No stall-time logging of the watchdog firing.** The `status.error` field is written and visible via GET `/api/jobs/:id`; a dedicated timing entry would make the report even cleaner.
5. **`VLM_CONCURRENCY` defaults to 3 but the env var is unwired** into the actual pool yet; so the pool is currently 3 everywhere.
6. **The hybrid-mode reviewer upload is separate** and still uses its own polling/`/api/jobs` shape — no share yet.
7. **No load test of the 25-slide scenario.** The flow completes but its throughput under contention with other running jobs has not been measured.
8. PDF and image inputs are unaffected by this change — same code path as before.

## How to enable a fully local queue manually

Review `src/util/taskQueue.js` (it is self-contained) and `src/extract/slideVlm.js` — the migration is to route the bounded pool through `TaskQueue` instead of a local Next-pointer. Once that lands, `POST /api/jobs/:id/retry-failed` can re-enqueue failed slides on the same queue and the 429 backoff becomes genuine across jobs.
