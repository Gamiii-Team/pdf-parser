# pdf-parser — figure_extraction (PDF Figure/Chart/Table Extractor, Florence-2 on Modal)

Renders every page of a PDF to an image, sends batches of pages over HTTPS to a
**Florence-2-large-ft** endpoint deployed on **Modal**, crops each detected
graphical region (figures, charts, tables, diagrams), filters out duplicates and
non-graphics, and saves exactly one image per table/figure — with the printed
caption line included in the crop — named after that caption. Writes a JSON
audit manifest covering saved, duplicate, rejected, and no-detection cases.

> This README covers the Python extractor in `figure_extraction/`. All commands
> below are meant to be run **from the repository root** (the directory
> containing this README).

## Repository layout

Everything lives in this one README; there are no nested docs. All configuration
— every app and mode — lives in **root `.env` / `.env.example` only** (no
per-folder env files). Links below jump straight to the code.

```
index.js                  # legacy JS demo: text + "tables" + visual-page candidates (unpdf)
src/
  extractor.js            # legacy unpdf text/table extraction (used by index.js)
  visual/pageDetector.js  # visual-page candidate detector (images, coverage, captions, grids)
  # --- chunked document extraction (see "Chunked document extraction" below) ---
  extractDocument.js      # mode-agnostic entry: input -> elements -> stitch -> chunk -> manifest
  cli.js                  # CLI: node src/cli.js <input> --mode <mode>
  config.js               # all env-driven config (no secrets hardcoded)
  elements.js             # element factory, normalized 0–1 bboxes, deterministic ids
  pdfModel.js             # born-digital PDFs -> script elements (unpdf + fontSize heuristics)
  render.js               # PDF/image inputs, pdftoppm rendering, page sizes (pdfinfo)
  florenceClient.js       # client for the deployed Florence-2 Modal apps
  stitch.js               # caption pairing, cross-page table merge, oversized-table split
  chunker.js              # headings -> sections -> chunks; completeness check; TOC; overlap
  schema.js               # Ajv validation against schemas/
  modes/
    pageImage.js          # full-modal / full-groq page pipeline (identical; adapter differs)
    hybridFlorence.js     # hybrid-florence: script elements + Florence figure detection
  providers/
    modalVllm.js          # OpenAI-compatible adapter (plain fetch) for the vLLM app
    groq.js               # Groq adapter (groq-sdk, qwen/qwen3.8-27b)
  figureAnalyzer/
    index.js              # swappable analyzer interface (florence | groq | modal-vllm)
    florence.js           # caption-only analyzer (structured data intentionally not invented)
    vlm.js                # VLM analyzer: type-specific prompts over a cropped figure
  prompts/                # versioned prompt files (never inline)
    page.prompt.md        # whole-page extraction prompt
    figure-chart.prompt.md  figure-flowchart.prompt.md  figure-photo.prompt.md
    index.js              # loader + {{placeholder}} filler
  util/                   # hash, FileCache, concurrency semaphore, retry/jitter, log, tokens
schemas/
  element.schema.json     # element contract (table rows required; figure type+description)
  chunk.schema.json       # chunked manifest chunk contract
  manifest.schema.json    # final manifest document (mode, model, toc, pages, …)
  raw-element.schema.json / raw-page-response.schema.json   # tolerant model-output schemas
modal/
  vllm_app.py             # Modal app florence2-vllm: vLLM + Qwen3-VL-4B-Instruct, OpenAI-compatible
figure_extraction/        # Python Florence-2 pipeline (Modal)
  florence.py             # app florence2-figure-extractor: page image -> detections + captions
  florence_pdf.py         # app florence2-pdf-extractor: whole PDF -> detections JSON (PDF→JSON)
  pipeline.py             # crop-and-save CLI (local post-processing; see "Run")
  pdf_to_json.py          # PDF -> Modal -> manifest-like JSON, no PNGs written (see below)
  requirements.txt        # local Python dependencies
tests/                    # node:test unit tests (chunker, stitch, elements, schema, page-image)
scripts/
  setup_modal.sh          # one-shot: secret -> deploy BOTH Florence apps -> .env wiring
  eval.js                 # side-by-side mode comparison on ./samples
test.pdf                  # sample PDF used in the examples below
extracted_figures/        # pipeline output (gitignored)
out/                      # extraction-mode output (gitignored)
.cache/extractions/       # paid-call cache (gitignored)
```

See **Deploying to Modal** below for how the Python apps and the vLLM app are
deployed, which `.env` variable each fills, and how auth works.

## Which scenario should I use?

The **same PDF** can go through three different pipelines. Pick by the output
you want; every command below spends real money (Modal GPU time or Groq API
calls), and each prints a `manifest.json` (or points to one).

| # | Command | What you get | Cost per run | First-time prerequisite |
|---|---|---|---|---|
| 1 | `python -m figure_extraction.pipeline ./test.pdf` | PNGs of each cropped figure/table + an audit `manifest.json` (schema v3) in `extracted_figures/test/` | 1 Modal run | nothing — detect app already deployed |
| 2 | `python -m figure_extraction.pdf_to_json ./test.pdf --out ./out/test.pdf.json` | one JSON only (manifest-like, schema v3, `no_images_saved: true`); **no PNGs written** | 1 Modal run | deploy `florence_pdf.py` once (step 6 of `setup_modal.sh`) |
| 3a | `node src/cli.js ./test.pdf --mode hybrid-florence` | **chunked** `manifest.json` + `run-report.json` (schema v1) for the downstream system | 1 Modal run | nothing — falls back to the deployed detect app |
| 3b | `node src/cli.js ./test.pdf --mode full-florence` | same chunked manifest, Florence-family flavor; image-path on Modal | 1 Modal run | nothing — shares the Florence endpoint |
| 3c | `node src/cli.js ./test.pdf --mode full-groq` | same as above, extraction via Groq (`qwen/qwen3.8-27b`) | 1 Groq call per page | `GROQ_API_KEY` in `.env` |
| 3d | `node src/cli.js ./test.pdf --mode full-modal` | same as above, extraction via your Modal vLLM app (`Qwen/Qwen3-VL-4B-Instruct` bf16) | 1 Modal GPU run | deploy `modal/vllm_app.py` once |
| 3e | `node src/cli.js ./test.pdf --mode full-qwen-8b` | same as above, extraction via Modal vLLM running `Qwen/Qwen3-VL-8B-Instruct-FP8` | 1 Modal GPU run | deploy `modal/full-qwen8b.py` once |
| 3f | `node src/cli.js ./test.pdf --mode full-qwen-27b` | same as above, extraction via Modal vLLM running `Qwen/Qwen3.8-27B-Instruct-FP8` | 1 Modal GPU run (A100-40GB) | deploy `modal/full-qwen27b.py` once |

Notes:

- **1 and 2** use the same Florence-2 model; 2 additionally skips writing crops
  and emits the pipeline's manifest as a single file (see the two sections below).
- **3x** all produce the *chunked document* manifest (headings → sections →
  chunks, completeness-checked, tables never split) consumed by the downstream
  system — they differ only in who runs the vision model. `hybrid-florence`
  and `full-florence` read the text layer locally and use Modal for figure
  detection; `full-groq`, `full-modal`, `full-qwen-8b` and `full-qwen-27b`
  send whole page images to a VLM.
- Scenarios 1 and 2 support a plain-text `--debug` flag (what the model saw vs.
  what it missed). The JS CLI (scenario 3x) has no debug flag; use
  `--figure-pass` there to additionally extract structured chart/flowchart data
  for figures. Each scenario's section below documents its exact flags:
  **Run**, **PDF → JSON (no crops) scenario**, **Chunked document extraction**.
- Cost reality check: a first Modal call after idle (or after a deploy) may
  cold-start for a minute; after `VLLM_SCALEDOWN_WINDOW` seconds idle
  (default 300), the vLLM container scales to zero and the next call cold-starts
  for ~1–3 minutes.
- Legacy demo: `node index.js` prints the extracted text / table rows / visual
  page candidates for `test.pdf` and writes nothing.

## Architecture

```
python -m figure_extraction.pipeline ./test.pdf
        │
        ▼  PyMuPDF render @ --dpi (default 200), one PNG per page
   batches of --batch-size pages (base64)
        │
        ▼  HTTPS POST  (header: X-API-Secret)
   Modal web endpoint — figure_extraction/florence.py
        │  <CAPTION_TO_PHRASE_GROUNDING> → boxes + phrase labels
        │  <MORE_DETAILED_CAPTION> per box
        ▼  200 OK {"model": ..., "results": [...]}
   local post-processing: clamp bbox → validate → crop →
   sanitize caption → dedupe filename → save PNG → manifest.json
```

The endpoint holds no state; your PDF pages leave this machine only as HTTPS
request payloads to your own Modal deployment.

## Requirements

- Python 3.10+, plus a [Modal](https://modal.com) account (free tier works)
- A virtual environment (`.venv`) — see setup below

## Setup (one-time)

Prerequisite — authenticate the Modal CLI once:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r figure_extraction/requirements.txt
python -m modal token new            # or: python -m modal setup
```

Then run the one-shot setup (idempotent, never prints secrets):

```bash
# from the repository root
bash scripts/setup_modal.sh
```

What the script does:

1. Creates `.venv` and installs `figure_extraction/requirements.txt` (if missing).
2. Seeds `.env` from `.env.example` (if missing) and generates `MODAL_API_SECRET`
   with `openssl rand -hex 32` directly into `.env` (if empty) — never shown.
3. Checks the Modal CLI is authenticated (fails with guidance otherwise).
4. Creates the Modal secret `florence-api` from `.env` (skips it if it already
   exists, with instructions to reset: `python -m modal secret delete florence-api`, then re-run).
5. Deploys `figure_extraction/florence.py`, greps the printed
   `https://...modal.run` URL, and writes `MODAL_FLORENCE_URL` back into `.env`.
   If the URL can't be parsed from the deploy output, the script tells you to
   paste it into `.env` manually — nothing breaks.
6. Deploys `figure_extraction/florence_pdf.py` (the PDF → JSON app) with the same
   secret, greps the `extract-pdf` URL, and writes `MODAL_PDF_EXTRACT_URL` into
   `.env` the same way.

After it finishes you're done — `.env` now holds all values and the pipelines
use them as-is (see below). Re-running the script is safe: existing secrets and
URLs are kept, missing ones are filled in.

<details>
<summary>Prefer manual steps? (click to expand)</summary>

```bash
# from the repository root
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r figure_extraction/requirements.txt
python -m modal token new

cp .env.example .env
# generate the secret and write it straight into .env (nothing printed):
sed -i "s/^MODAL_API_SECRET=.*/MODAL_API_SECRET=$(openssl rand -hex 32)/" .env

# load .env into the shell without echoing values, then create the secret:
set -a; source .env; set +a
python -m modal secret create florence-api \
    MODAL_API_SECRET="$MODAL_API_SECRET" \
    VISION_MODEL="$VISION_MODEL"

# deploy, then paste only the printed URL into .env:
python -m modal deploy figure_extraction/florence.py
sed -i "s|^MODAL_FLORENCE_URL=.*|MODAL_FLORENCE_URL=<printed URL>|" .env
```

</details>

Prefer not to activate the venv? Call the venv binaries directly, e.g.
`.venv/bin/python -m figure_extraction.pipeline ./test.pdf` and
`.venv/bin/modal deploy ...`.

The first deploy builds the Modal image (torch + transformers) and downloads
`microsoft/Florence-2-large-ft` (~1.5 GB) into the Modal container; the first
call afterwards may cold-start for a minute. The heavy ML deps live in the
Modal image, not in this repo.

## Secrets & safety

- **`.env` is the single source of truth** and is gitignored — it never leaves
  your machine via this repo. `.env.example` ships only placeholders.
- Nothing in the docs or scripts ever contains literal secret values — commands
  reference `$MODAL_API_SECRET` / `$MODAL_FLORENCE_URL` from `.env` instead.
- The endpoint URL alone is not a credential (requests need the
  `X-API-Secret` header), but treat URL + `MODAL_API_SECRET` as a pair anyway.
- **Rotate the secret**: `sed -i "s/^MODAL_API_SECRET=.*/MODAL_API_SECRET=$(openssl rand -hex 32)/" .env`,
  then `python -m modal secret delete florence-api` and re-run
  `bash scripts/setup_modal.sh` (it recreates the secret and re-deploys).
- If you suspect a leak: rotate immediately, and check `modal secret list`.
  Never paste `.env` contents into issues, chat, or CI logs — liveness probe
  is the separate `healthz` Modal function URL printed by `modal deploy`
  (e.g. `…--florence2-figure-extractor-healthz.us-east.modal.run`), not a path
  on the `detect` URL.

## Run

```bash
# from the repository root; activate the venv first if not already active
source .venv/bin/activate
python -m figure_extraction.pipeline ./test.pdf \
    --output-dir ./extracted_figures \
    --dpi 200 \
    --min-width 120 --min-height 120 \
    --blank-stddev 2.0 \
    --max-aspect-ratio 15 \
    --batch-size 4 # Number of pages sent to Modal.
```

Output layout (relative to the `--output-dir` you pass):

```
./extracted_figures/<pdf-stem>/
    <caption-slug>.png            # one file per saved crop
    ...
    manifest.json                 # audit manifest (see below)
```

## Deploying the vLLM app for `full-modal` (`modal/vllm_app.py`)

Same shape as the Florence deploy: one Python file, one Modal CLI call. The
difference is *only* how the app is wired — a GPU container (T4 / A10G /
A100-40GB) rather than a CPU fastapi endpoint — and where Modal reads its
configuration: `modal/vllm_app.py` reads `VLLM_*` from the shell environment
at deploy time, so load `.env` first.

### Preconditions
- Modal CLI authenticated (`python -m modal token new` — once, done for Florence)
- A payment method on file (all GPU Modal instances require one)
- `.env` complete — at minimum `VLLM_MODEL`, `VLLM_GPU`, `MODAL_API_SECRET`,
  `MODAL_ENDPOINT_URL`
- `VLLM_GPU=A100-40GB` set in `.env` (the value Modal reads at deploy time —
  plain `A100` may silently upgrade you to 80 GB, `A100-40GB` forces 40 GB)

### Commands (one-time)

```bash
# 1) Load .env into the shell (vllm_app.py reads os.environ at import time)
set -a; source .env; set +a

# 2) Deploy the vLLM app
python -m modal deploy modal/vllm_app.py
#   → Modal builds the image (~8 GB bake with the model weights)
#   → prints the endpoint URL, e.g. https://<you>--florence2-vllm-proxy.us-east.modal.run

# 3) Wire the proxy URL into .env
sed -i "s|^MODAL_ENDPOINT_URL=.*|MODAL_ENDPOINT_URL=<printed proxy URL>|" .env
```

### Verify (no GPU needed for the liveness check)

```bash
# Liveness — separate non-GPU function, always returns {"status":"ok"} quickly
curl -s https://<you>--florence2-vllm-healthz.us-east.modal.run

# Smoke test: authenticated chat completion (auth = same secret as florence-api)
curl -s -X POST https://<you>--florence2-vllm-proxy.us-east.modal.run/v1/chat/completions \
  -H "Authorization: Bearer $MODAL_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"model":"Qwen/Qwen3-VL-4B-Instruct",
       "messages":[{"role":"user",
                    "content":[{"type":"text",
                                  "text":"Say OK"}]}],
       "max_tokens":8,"stream":false}'
# Expected: a normal OpenAI-shaped chat completion with a short reply
```

### Usage

```bash
node src/cli.js ./test.pdf --mode full-modal
# → out/test/manifest.json   (chunked manifest, schema v1)
# → out/test/run-report.json (timing, tokens, retries, cache hits)
```

### What the commands actually do
- `modal deploy modal/vllm_app.py` uploads the file; at import time it reads
  `VLLM_GPU`, `VLLM_MODEL`, `VLLM_SCALEDOWN_WINDOW`, `VLLM_MAX_MODEL_LEN`
  and builds the image (baking
  `Qwen/Qwen3-VL-4B-Instruct` weights into a layer at build time).
- The CPU-only `healthz` function is always compiled; the GPU function
  `proxy` is what handles real requests.
- The proxy checks `Authorization: Bearer $MODAL_API_SECRET` against the
  `florence-api` Modal secret before it ever touches the GPU, then forwards the
  request to an in-container `vllm serve` on `127.0.0.1:8000`.
- After 300 s idle (`VLLM_SCALEDOWN_WINDOW`) the GPU container is released
  (A100-40GB ≈ **$2.10/hr** while it lives).

### Troubleshooting
- HTTP 401 → `MODAL_API_SECRET` in `.env` ≠ secret inside `florence-api`
  (`python -m modal secret delete florence-api` then re-run `setup_modal.sh`).
- 503 `{"error":"no upstreams available"}` → GPU allocated but `vllm serve`
  crashed; check logs with `.venv/bin/python -m modal app logs florence2-vllm`.
- Container stuck at `Pending` → GPU pool contention on the workspace plan;
  fall back to `VLLM_GPU=T4` (fits 4B bf16 ~8 GB) or bump your Modal plan.

## Endpoint contract (`figure_extraction/florence.py`)

|                |                                                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------------------------------- |
| Deploy         | `python -m modal deploy figure_extraction/florence.py`                                                            |
| `POST /`       | body `{"images": ["<base64 PNG>", ...], "phrases": "<optional>"}`, max 16 images                                  |
| Auth           | header `X-API-Secret: <MODAL_API_SECRET>` (401 otherwise)                                                         |
| Response (200) | `{"model": "microsoft/Florence-2-large-ft", "results": [...]}`                                                    |
| `results[i]`   | `[{bbox, label, caption}]` for page `i`, or `{"page_error": "..."}` if that page failed (batch still returns 200) |
| `GET /healthz` | unauthenticated liveness probe → `{"status": "ok"}`                                                               |
| Secret source  | Modal secret `florence-api` read via `modal.Secret.from_name(...)`; never baked into the image, never logged      |

`.env` is gitignored; `.env.example` documents the variables. The endpoint is
yours — anyone with the URL still can't call it without `X-API-Secret`.

## PDF → JSON (no crops) scenario (`figure_extraction/florence_pdf.py`)

A second, independent Modal app for when you'd rather send **the PDF itself**
to Modal and get one JSON file back instead of cropped PNGs + a manifest in
the normal folder layout. Same `florence-api` secret, same Florence-2 model,
same local post-processing — just delivered differently:

1. `pdf_to_json.py` uploads the whole PDF (base64) to the new endpoint.
2. The `florence2-pdf-extractor` app renders pages **server-side** with
   PyMuPDF and runs Florence-2 on them — no local rendering needed for the
   detection itself.
3. The returned boxes/labels/captions flow through the **same** local
   post-processing as the regular pipeline (crop → validate → caption match →
   embedding filter → dedup → reconciliation), so the JSON matches a real
   `manifest.json` (schema v3) — minus the PNGs: top-level
   `"no_images_saved": true` is set and `filename` holds the would-be names.
4. Page images are re-rendered locally at the same DPI only to feed the
   local post-processing (spans, validation, dHash) — geometry is identical
   because PyMuPDF rendering is deterministic.

|                |                                                                                   |
| -------------- | --------------------------------------------------------------------------------- |
| Deploy         | `python -m modal deploy figure_extraction/florence_pdf.py`                        |
| `POST /`       | body `{"pdf_b64": "<base64 PDF>", "dpi": 200, "phrases": "<optional>"}`            |
| Input limits   | ≤ 25 MB, must start with `%PDF`, DPI clamped to 72–400                        |
| Auth           | header `X-API-Secret: <MODAL_API_SECRET>` (401 otherwise), same secret as `detect` |
| Response (200) | `{"model": ..., "dpi": 200, "pages": <n>, "results": [...]}`                      |
| `results[i]`   | detections for page `i+1`, or `{"page_error": "..."}` for that page               |
| `GET /healthz` | unauthenticated liveness probe → `{"status": "ok"}`                                 |
| Secret source  | Modal secret `florence-api` — the same secret as the other app                    |

Setup: `scripts/setup_modal.sh` already deploys this app too and writes
`MODAL_PDF_EXTRACT_URL` into `.env` (step 6). To deploy it by hand instead:
deploy, then copy the printed `https://...modal.run` URL into `.env` as
`MODAL_PDF_EXTRACT_URL=...`.

```bash
# from the repository root
python -m figure_extraction.pdf_to_json ./test.pdf --out ./test.pdf.json
python -m figure_extraction.pdf_to_json ./test.pdf --out ./test.pdf.json --debug   # also print the debug summary
```

Output notes: `--out` defaults to `./<pdf-stem>.json`; the JSON is written
wherever your working directory is; nothing else is written to disk. Cost is
one Modal T4 call (plus a local re-render); a first call after a redeploy may
cold-start for a minute. Table 2-style model misses still appear as
`status: "not_detected"` entries — this route does not detect differently,
it just delivers the same pipeline output as one JSON file.

## Chunked document extraction (`src/extractDocument.js`)

Next to the crop-and-save pipeline, the repo contains a separate **document
extraction** flow that produces a single chunked `manifest.json` per input
document — the format consumed by the downstream system (search, embeddings,
LLM feeding, display). It keeps everything from the source document (text,
tables, figures, captions) and breaks it into stable, well-structured chunks;
nothing is silently dropped.

```bash
node src/cli.js ./test.pdf --mode hybrid-florence          # text layer + Modal Florence-2 figures
node src/cli.js ./test.pdf --mode full-florence            # same flow; its own run + out dir
node src/cli.js ./test.pdf --mode full-groq                # page images -> Groq API (qwen/qwen3.8-27b)
node src/cli.js ./test.pdf --mode full-modal               # page images -> Modal vLLM (Qwen3-VL-4B-Instruct)
node src/cli.js ./test.pdf --mode full-qwen-8b             # page images -> Modal vLLM (Qwen3-VL-8B-Instruct-FP8)
node src/cli.js ./test.pdf --mode full-qwen-27b            # page images -> Modal vLLM (Qwen3.8-27B-Instruct-FP8, A100-40GB)
node --test tests/                                         # unit tests, no network
node scripts/eval.js samples/                              # side-by-side mode comparison
```

| Mode | Best for | Inference |
|---|---|---|
| `hybrid-florence` | born-digital PDFs with a text layer | local unpdf + Florence-2 crops for figures |
| `full-florence` | same, but its own run/output namespace | same engine as `hybrid-florence`; `mode: "full-florence"` in the manifest |
| `full-groq` | scans, images, any PDF | Groq API (vision model, `GROQ_MODEL`) |
| `full-modal` | same, self-hosted | Modal + vLLM (`Qwen/Qwen3-VL-4B-Instruct` default, see **Deploying to Modal** below) |
| `full-qwen-8b` | same, richer model | Modal + vLLM (`Qwen/Qwen3-VL-8B-Instruct-FP8`, fits T4) |
| `full-qwen-27b` | same, strongest model | Modal + vLLM (`Qwen/Qwen3.8-27B-Instruct-FP8`, needs A100-40GB) |

Outputs (per run, in `--out` dir or `out/<stem>/<mode>/`): `manifest.json`
(chunked, Ajv-validated, completeness-checked — every extracted element lands
in exactly one chunk) and `run-report.json` (pages, timing, tokens, cache hits,
retries, warnings, completeness result). Elements are typed (`heading |
paragraph | table | figure | equation | code | list | caption`) with normalized
0–1 `bbox`,
`source`, `needs_review`; figures carry `figure_type` + type-specific `data`
(chart values are always marked as estimates); tables carry 2D `rows` with
`header_rows`. Chunks carry `section_path` (from detected headings), `pages`,
`token_estimate`, `prev_id`/`next_id`, and a table-of-contents is built into
`document.toc`. Chunking never splits a table/figure/equation/code block across
chunks and never separates a caption from its figure/table; oversized tables
are split by row groups with the header repeated.

`.env.example` is the exhaustive source of truth — every variable read by
`src/config.js`, the Python clients, and the Modal vLLM app at deploy time is
documented there. Key ones: `GROQ_API_KEY`, `GROQ_MODEL`,
`MODAL_ENDPOINT_URL`, `MODAL_API_SECRET` (same secret as the Florence apps),
`MODAL_PDF_EXTRACT_URL`, `DPI` (default 170), `CHUNK_TARGET_TOKENS` /
`CHUNK_MAX_TOKENS` / `CHUNK_MIN_TOKENS` / `CHUNK_OVERLAP_TOKENS`,
`CONCURRENCY`, `MODEL_RETRIES`, `CACHE_DIR` (results cached by image hash +
mode + model + prompt version — reruns don't re-pay for model calls). The
Modal vLLM app is deployed with `python -m modal deploy modal/vllm_app.py`
and also honors `VLLM_GPU` / `VLLM_SCALEDOWN_WINDOW` / `VLLM_MAX_MODEL_LEN`
(see the **Deploying to Modal** section).

Notes / limitations: chart values read from pixels are estimates (always
flagged `estimates`/`needs_review`); `full-groq` needs `GROQ_API_KEY` and the
mode currently ships untested against the live API — see the summary for the
current verification status. The Modal vLLM endpoint is provided in
`modal/vllm_app.py` — see **Deploying to Modal** below.

## Deploying to Modal

Everything Modal-related in this repo is deployed the same way — the only
difference is *who* runs the deploy command and what URL lands in `.env`.
Modal is a hosting platform: when you deploy a function, Modal gives it a
public HTTPS URL of the form
`https://<your-workspace>--<app-name>-<function-name>.modal.run` and serves it
for you. That URL is what the pipelines call; it is **not** a credential.

### One-time: authenticate the Modal CLI

```bash
python -m modal token new        # or: python -m modal setup
```

This writes `~/.modal.toml` with your workspace token — every `modal` command
from then on uses it. (The same step is required before `bash scripts/setup_modal.sh`.)

### The `florence-api` secret (shared by all apps)

All three Modal apps read the same Modal secret, `florence-api`, created by
`setup_modal.sh` from the root `.env`:

- `MODAL_API_SECRET` — random 32-byte hex, generated once with `openssl rand -hex 32`
  (never printed, never committed)
- `VISION_MODEL` — `florence-2-large` or `florence-2-base`

The vLLM app exposes that same value to vLLM as `--api-key`, and the JS and
Python clients send it as `Authorization: Bearer <MODAL_API_SECRET>` /
`X-API-Secret: <MODAL_API_SECRET>`. So there is exactly one secret to manage.

### What to deploy, in order

| # | Command | What it does | `.env` variable it fills |
|---|---|---|---|
| 1 | `bash scripts/setup_modal.sh` | Creates `.venv`, checks Modal auth, creates `florence-api` (if missing), generates `MODAL_API_SECRET` (if empty) | reads/writes both above |
| 2 | (same script, step 5) | Deploys `figure_extraction/florence.py` → greps URL | `MODAL_FLORENCE_URL` |
| 3 | (same script, step 6) | Deploys `figure_extraction/florence_pdf.py` → greps URL | `MODAL_PDF_EXTRACT_URL` |
| 4 | `python -m modal deploy modal/vllm_app.py` | Deploys the vLLM app (see below) — kept manual on purpose | `MODAL_ENDPOINT_URL` |

`setup_modal.sh` is idempotent: existing secrets and URLs are kept, missing
ones are filled in, and if a URL can't be parsed from the deploy log it tells
you to paste it into `.env` manually. The vLLM app stays manual because its
image bakes ~8 GB of model weights (build time + GPU bill) — it should be an
explicit decision, not a surprise inside a setup script.

If a deploy prints more than one `.modal.run` URL, the Florence apps are named
`--florence2-figure-extractor-detect` / `--florence2-figure-extractor-healthz`
and `--florence2-pdf-extractor-extract-pdf` / `...-healthz`; the vLLM app
prints `--florence2-vllm-run` and `--florence2-vllm-healthz`.

### Deploy and run `full-modal` (copy-paste)

```bash
# 0) one-time Modal auth (writes ~/.modal.toml with your workspace token)
python -m modal token new

# 1) deploy the Florence apps (fills MODAL_FLORENCE_URL / MODAL_PDF_EXTRACT_URL)
bash scripts/setup_modal.sh

# 2) deploy the vLLM app — one-time ~8 GB image bake (GPU is billed only while it runs)
python -m modal deploy modal/vllm_app.py

# 3) wire the printed URL into .env (replace the empty MODAL_ENDPOINT_URL= line)
sed -i "s|^MODAL_ENDPOINT_URL=.*|MODAL_ENDPOINT_URL=<printed URL>|" .env

# 4) smoke-test the instance itself
curl -s https://<you>--florence2-vllm-healthz.modal.run
curl -s https://<you>--florence2-vllm-run.modal.run/v1/chat/completions \
  -H "Authorization: Bearer $MODAL_API_SECRET" -H "Content-Type: application/json" \
  -d '{"model":"Qwen/Qwen3-VL-4B-Instruct",
       "messages":[{"role":"user","content":[{"type":"text","text":"Say OK"}]}],
       "max_tokens":8,"stream":false}'

# 5) run the extraction against the instance
node src/cli.js ./test.pdf --mode full-modal
# outputs: out/test/manifest.json and out/test/run-report.json
```

Cost notes: step 2 builds/downloads once (slow first build; later deploys reuse
cached layers). GPU billing starts only when the function runs; after
`VLLM_SCALEDOWN_WINDOW` seconds idle (default 300) it scales to zero, and the
next call cold-starts for ~1–3 minutes (be patient with the first `curl`).

**Using this instance without the pipeline** — it is just an OpenAI-compatible
server. Any OpenAI client works:

```js
import OpenAI from "openai";
const client = new OpenAI({
  baseURL: "https://<you>--florence2-vllm-run.modal.run/v1",
  apiKey: process.env.MODAL_API_SECRET,
});
const resp = await client.chat.completions.create({
  model: "Qwen/Qwen3-VL-4B-Instruct",
  messages: [{ role: "user", content: "Say OK" }],
  max_tokens: 8,
  stream: false,
});
console.log(resp.choices[0].message.content);
```

If step 1 or 2 fails: see the **Troubleshooting** list in *The vLLM app — what
you should know* below. Most first-time issues are (a) Modal CLI not
authenticated (step 0), (b) the `vllm/vllm-openai` image tag not supporting the
model architecture (bump `VLLM_IMAGE_TAG` in `modal/vllm_app.py`), or (c) GPU
quota/availability on your plan.

#### Full-Qwen Modal apps (`full-qwen-8b` / `full-qwen-27b`)

Same pattern as the vLLM app above, but committed to one model per file. All
three apps share the `florence-api` secret (same `MODAL_API_SECRET`).

**`modal/full-qwen8b.py` → `qwen-8b` app (full-qwen-8b)**
- Serves `Qwen/Qwen3-VL-8B-Instruct-FP8` on a **T4** by default (override the
  GPU with `VLLM_GPU_8B` at deploy time)
- Fits comfortably on a 16 GB T4; good general-purpose checkpoint for page JSON
- Used by `node src/cli.js ./test.pdf --mode full-qwen-8b`
- Deploy:
  ```bash
  set -a; source .env; set +a
  python -m modal deploy modal/full-qwen8b.py
  # then paste the printed URL into .env as MODAL_FULL_QWEN_8B_URL
  ```

**`modal/full-qwen27b.py` → `qwen-27b` app (full-qwen-27b)**
- Serves `Qwen/Qwen3.8-27B-Instruct-FP8` on an **A100-40GB** by default
  (override with `VLLM_GPU_27B` at deploy time — see `.env` / `.env.example`)
- The strongest model this workspace can run — pick this if `qwen-8b` misses
  table cells or leaves dense pages as stubs
- Used by `node src/cli.js ./test.pdf --mode full-qwen-27b`
- Deploy:
  ```bash
  set -a; source .env; set +a
  python -m modal deploy modal/full-qwen27b.py
  # then paste the printed URL into .env as MODAL_FULL_QWEN_27B_URL
  ```

Both apps bake the model into the image at build time (downloads once), expose
a `/healthz` always-readiness endpoint, and scale to zero after
`VLLM_SCALEDOWN_WINDOW` seconds idle.

### The vLLM app (`modal/vllm_app.py`) — what you should know

Serves **Qwen/Qwen3-VL-4B-Instruct** (override with `VLLM_MODEL`) through
vLLM's OpenAI-compatible server. Used by the `full-modal` extraction mode.

- **GPU**: needs a T4-class 16 GB card. Default `VLLM_GPU=T4` — the
  4B bf16 weights (~8 GB) fit comfortably with `--enforce-eager`.
  (On this workspace, L4/A10G instances were scheduling-blocked at deploy
  time, so T4 — proven by the Florence apps — is the default.)
- **Weights**: the image build downloads the model at build time (~8 GB;
  first deploy is slow, later deploys reuse cached layers). No runtime
  cache volume is mounted — it would shadow the baked weights.
- **Scale-to-zero**: after `VLLM_SCALEDOWN_WINDOW` seconds idle (default 300)
  the container scales down; the next call cold-starts in roughly 1–3 minutes.
- **Auth**: vLLM runs with `--api-key $MODAL_API_SECRET`; `.env` needs
  `MODAL_ENDPOINT_URL` (paste the URL the deploy prints).
- **Smoke test**:

```bash
curl -s https://<you>--florence2-vllm-healthz.modal.run                # -> {"status":"ok"}
curl -s https://<you>--florence2-vllm-run.modal.run/v1/chat/completions \
  -H "Authorization: Bearer $MODAL_API_SECRET" -H "Content-Type: application/json" \
  -d '{"model":"Qwen/Qwen3-VL-4B-Instruct",
       "messages":[{"role":"user","content":[{"type":"text","text":"Say OK"}]}],
       "max_tokens":8,"stream":false}'
```

| Env var (deploy) | Default | Purpose |
|---|---|---|
| `VLLM_MODEL` | `Qwen/Qwen3-VL-4B-Instruct` | Any model id vLLM supports (e.g. `Qwen/Qwen2.5-VL-7B-Instruct`) |
| `VLLM_GPU` | `T4` | GPU class for the container |
| `VLLM_SCALEDOWN_WINDOW` | `300` | Idle seconds before scale-to-zero |
| `VLLM_MAX_MODEL_LEN` | `16384` | Context length cap |

Troubleshooting: **401** → `.env` `MODAL_API_SECRET` ≠ `florence-api` secret
(recreate the secret: `python -m modal secret delete florence-api`, re-run
`setup_modal.sh`). **CUDA OOM** → lower `VLLM_MAX_MODEL_LEN`, or
`VLLM_GPU=T4`. **Very slow first deploy** → image build downloads ~8 GB,
normal. **Model architecture not supported** → bump `VLLM_IMAGE_TAG` in
`vllm_app.py` to a newer vLLM release.

**Status**: not yet deployed/verified end-to-end — it will be once you run step 4
and `node src/cli.js ./test.pdf --mode full-modal`.

### Verifying everything is wired up

```bash
curl -s $MODAL_FLORENCE_URL/healthz        # -> {"status":"ok"}
curl -s ${MODAL_PDF_EXTRACT_URL}/healthz   # -> {"status":"ok"} (after step 3/6)
python -m figure_extraction.pipeline ./test.pdf
python -m figure_extraction.pdf_to_json ./test.pdf --out ./test.pdf.json --debug
```

## How Florence-2 is used, and how outputs become crops + filenames

Florence-2 is called **only inside `figure_extraction/florence.py`** (`detect`),
once per batch of pages:

1. `<CAPTION_TO_PHRASE_GROUNDING>` with the phrases
   `"figure . chart . graph . diagram . table . pie chart . bar chart .
line chart . scatter plot . flowchart"` →
   `{bboxes: [[x1,y1,x2,y2], ...], labels: [phrase, ...]}` per page.
2. Each grounded box is cropped from the page image and captioned with
   `<MORE_DETAILED_CAPTION>` → a descriptive sentence.
3. Back on your machine (`figure_extraction/pipeline.py`), each detection
   passes a **single-pass queue** of steps:
   - **Oversized reject** — a box covering >80% of the page is rejected
     (`reason: oversized`); it would essentially save the whole page.
   - **Caption anchoring** — literal caption lines in the page's text layer
     ("Table 1:", "Figure 2:" …) nearest to the box are found and the crop is
     **expanded to include the printed caption inside the image**. Caption
     lines are matched with `^(table|figure|fig\.?|chart|graph|exhibit)\s*[0-9]`
     — non-English "Figure 1"/"Table 2" localizations need the regex extended.
     **By default a crop with no caption line is rejected as** `caption_not_found` —
     caption-anchored detection only (Florence-2 boxes must belong to a printed
     caption). On scanned PDFs (no text layer) this rejects everything —
     re-run with `--allow-uncaptioned` there to keep captionless graphics.
   - **Embedding filter** — a local MiniLM model embeds the Florence caption
     and cosine-compares it against graphic prototypes (`a table / a bar
chart / a pie chart / a line graph / a diagram or figure`) and negative
     prototypes (`a logo / ...`); losers are rejected as `non_graphic:*`.
     Borderline matches are kept with a `borderline` flag. Nothing here runs
     on Modal.
   - **Fingerprint dedup** — identical boxes (page + rounded bbox) are
     `duplicate_fingerprint:*`-rejected without rechecking.
   - **Whole-document dedup** — after the PDF is fully read, boxes on the
     same page are collapsed: IoU > 0.6 (configurable `--iou`), containment
     > 0.8, or dHash Hamming distance ≤ 8 ⇒ `duplicate_of:<best-id>`. One
     > box per table/figure survives; Florence emits overlapping boxes for the
     > same element, and this is what collapses them.
   - **Validate + save** — the crop (caption included) is saved as a PNG.
   - **Caption reconciliation** — caption lines found in the text layer that
     no detection anchored to (a grounding miss, e.g. a borderless table the
     model didn't box) are reported as an `unmatched_caption:` warning plus a
     synthetic manifest entry with `status: "not_detected"` /
     `reason: "caption_not_detected"` (id `caption-<page>-<n>`). These are
     never silently dropped: the manifest always accounts for every caption
     line found.

**Filename rules** (`slugify` in `figure_extraction/pipeline.py`): the literal
caption line ("Figure 2: Share of sales by product") wins; fallback is
`{pdf_stem}_p{page}_fig{index}.png` (flag `fallback_filename`). Result is
lowercased → non `[a-z0-9]` stripped → whitespace/underscores → `-` → repeats
collapsed → trimmed to ≤ 80 chars at a word boundary. Collisions get `_2`, `_3`
… appended (flag `deduplicated_filename`).

## Manifest format (`manifest.json`)

```jsonc
{
  "schema_version": 3,
  "source_pdf": "/abs/path/test.pdf",
  "model": "florence-2-large",
  "dpi": 200,
  "inference": {
    "transport": "http",
    "url": "https://<you>--florence2-figure-extractor-detect.modal.run",
  },
  "created_at": "2026-11-09T...",
  "output_dir": "/abs/path/extracted_figures/test",
  "caption_lines_found": 4,
  "warnings": [],
  "pages": [
    // one entry per page
    { "page": 1, "status": "ok", "detections": 7 },
    { "page": 2, "status": "no_detections" },
    { "page": 3, "status": "error", "error": "..." },
  ],
  "crops": [
    // one entry per candidate region, saved or rejected
    {
      "id": "det-2-12", // stable per run; used for duplicates
      "source_pdf": "/abs/path/test.pdf",
      "page": 2,
      "bbox": [22.0, 268.0, 500.0, 700.0], // expanded box actually cropped
      "bbox_detected": [22.0, 233.0, 500.0, 640.0], // original Florence box
      "label": "figure",
      "caption": "A bar chart showing monthly revenue...", // Florence's caption
      "caption_line": "Figure 1: Monthly revenue", // printed line in the page
      "caption_found": true,
      "embedding": {
        "verdict": "graphic", // graphic | borderline | non_graphic
        "graphic_score": 0.6683,
        "nearest_graphic": "a bar chart",
        "negative_score": 0.2013,
        "nearest_negative": "a photograph or image",
      },
      "confidence": null, // Florence-2 emits no per-box confidence
      "filename": "figure-1-monthly-revenue.png",
      "status": "saved", // "rejected" | "not_detected" (caption found, no detection anchored to it)
      "reason": "", // rejection reason when status=rejected
      "flags": ["caption_included"], // or caption_not_found / borderline / non_graphic / duplicate / caption_undetected ...
    },
  ],
}
```

Rejected crops are kept in the manifest with `status: "rejected"` and a
`reason` (`too_small`, `mostly_blank`, `extreme_aspect_ratio`, `oversized`,
`non_graphic:*`, `duplicate_fingerprint:*`, `duplicate_caption_key:*`,
`duplicate_of:<id>`). Caption lines found in the text layer that no detection
anchored to are recorded with `status: "not_detected"` /
`reason: "caption_not_detected"` (no image is saved for them) and an
`unmatched_caption:` warning — `caption_lines_found` therefore always
reconciles: every found caption either backs a saved/rejected crop or is
flagged as `not_detected`. Page-level
failures are logged per page and processing continues with the rest of the PDF;
a page that fails to render or to be processed is recorded under `pages` with
`status: "error"`. Missing `.env` config aborts before any page is rendered
with exit code 2 and an actionable message. HTTP 401 aborts the run the same
way; other HTTP/network failures are recorded per page and the rest continues.

## Validation & guardrails

| Check                                         | Default                      | Flag                          |
| --------------------------------------------- | ---------------------------- | ----------------------------- |
| Minimum crop size                             | 120×120 px                   | `--min-width`, `--min-height` |
| Extreme aspect ratio                          | 15:1 (0 to disable)          | `--max-aspect-ratio`          |
| Mostly blank (stddev)                         | grayscale stddev < 2.0       | `--blank-stddev`              |
| Mostly blank (near-white)                     | ≥ 99.5% pixels ≥ 245         | (fixed)                       |
| Oversized detection (>80% of page)            | rejected as `oversized`      | (fixed)                       |
| Duplicate graphic (IoU / containment / dHash) | IoU > 0.6 / > 0.8 / ≤ 8 bits | `--iou`                       |
| Non-graphic filter (MiniLM cosine)            | margin 0.05 vs prototypes    | `--margin`                    |
| Caption-anchored only (caption required)      | on                           | `--allow-uncaptioned`         |
| Keep non-graphic detections anyway            | off                          | `--keep-nongraphic`           |
| Filename max length                           | 80 chars                     | (fixed, see `slugify`)        |
| Max images per endpoint call                  | 16                           | (fixed, server-side)          |

## Performance / cost notes

- Pages are rendered once at the configured DPI (default 200; lower it with
  `--dpi` for cheaper/faster runs); only inference runs on Modal.
- Cost is dominated by Florence-2-large-ft forward passes (roughly 4×
  base-ft per call): ~1 grounding call + N caption calls per page.
  Decrease DPI, narrow `--phrases`, or `--batch-size 2` to cut timeouts.
- Modal GPUs bill per second; idle containers scale down after
  `scaledown_window` (300 s). Deploy once; the URL stays stable across runs.
- Model choice: `VISION_MODEL` in the Modal secret (`florence-2-base` or
  `florence-2-large`) — maps server-side to `microsoft/Florence-2-*-ft`.
  Re-running `modal deploy` applies the change.

## Troubleshooting

| Symptom                                                                  | Cause / fix                                                                                                          |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `Configuration error: Missing MODAL_FLORENCE_URL...` (exit 2)            | `.env` missing/incomplete — run `bash scripts/setup_modal.sh` (or copy `.env.example` → `.env` and fill both values) |
| `401 Unauthorized` from the endpoint                                     | `MODAL_API_SECRET` in `.env` ≠ secret in `florence-api` — recreate the Modal secret or fix `.env`                    |
| All pages `page_error: endpoint_unreachable: ...`                        | endpoint not deployed / wrong URL / network down — check the separate `healthz` function URL from the deploy output  |
| Timeouts on big pages                                                    | lower `--dpi`, or `--batch-size 1..2`; first call after deploy is a cold start                                       |
| `pdf_to_json`: `Configuration error: Missing MODAL_PDF_EXTRACT_URL...` | the second app isn't deployed or its URL isn't in `.env` — re-run `bash scripts/setup_modal.sh` (or deploy it manually and paste the printed URL as `MODAL_PDF_EXTRACT_URL=...`) |
| `pdf_to_json`: page-count mismatch error                               | endpoint returned fewer results than pages — re-run; if it persists, check the app logs in the Modal dashboard for a rendered page raising inside detection |
| `modal: command not found`                                               | activate `.venv` (`source .venv/bin/activate`) or use `.venv/bin/modal`                                              |
| `"caption_lines_found": 0` and all pages rejected as `caption_not_found` | the PDF has no text-layer caption lines (likely scanned) — re-run with `--allow-uncaptioned`                         |
| A `not_detected` crop / `unmatched_caption:` warning for a caption | the model's grounding missed that graphic (common for borderless tables). No box ⇒ no crop; re-run with higher `--dpi` or `--phrases` emphasizing the element type, or accept it as an audited gap |
| `modal deploy` fails auth                                                | `python -m modal token new`                                                                                          |

## Notes / limitations

- Scanned PDFs: caption anchoring and the caption-required rule need a text
  layer — for pure scans, re-run with `--allow-uncaptioned` (the manifest will
  also warn when `caption_lines_found` is 0).
- `confidence` is always `null`: Florence-2's grounding task does not return
  probabilities. Use `flags`/`reason` plus manual spot-checks for filtering.
- The embedding filter rejects logos/photos/icons as `non_graphic:*`; use
  `--keep-nongraphic` to keep them (flagged) if you later want them, e.g. for
  a review UI.
- Secrets live in `.env` (gitignored) and the Modal secret store; neither is
  committed to this repo.
