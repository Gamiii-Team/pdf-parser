# pdf-parser

**Document → structured JSON** for born-digital PDFs, scanned PDFs, PowerPoint decks, and image files. Extracts the complete text content, tables (as cell grids), and figures/charts (as structured data) and emits a recursive `sections[]` tree intended to be consumed by a language model.

No Florence-2, no chunking, no markdown strings: tables and charts are structured data throughout.

## What's here

| Path                     | Purpose                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `src/cli.js`             | CLI entry                                                                              |
| `src/extractDocument.js` | Orchestrator (normalize → route → extract → tree → validate → write)                   |
| `src/pymupdf/`           | Python worker: page analysis, table finding, image wraps, renders/crops                |
| `src/input/`             | Input normalization (PDF wrap / PPTX→PDF via locked-down LibreOffice container / image→PDF) + per-page routing |
| `src/extract/`           | text-layer extractor, VLM page path, figure analyzer, tree builder                     |
| `src/validate/`          | Offline validators (text coverage, chart sanity, table sanity)                         |
| `src/providers/`         | VLM backends (`groq` default, `modal` OpenAI-compatible vLLM)                          |
| `UI/`                    | Single-page browser UI (dark dashboard) — every pipeline feature mapped to the browser |
| `test.pdf`               | Born-digital fixture (committed)                                                       |
| `fixtures/scanned.pdf`   | Image-only fixture (generated from `test.pdf` at 150 dpi)                              |
| `fixtures/page-one.png`  | Single-image fixture                                                                   |
| `fixtures/sample.pptx`   | PowerPoint fixture (3 visible slides + 1 hidden + 1 empty; PyMuPDF-drawn readable bar chart) |
| `docker/converter/`      | Locked-down LibreOffice container that converts .pptx → PDF                            |
| `compose.converter.yaml` | Optional manual runner for the converter (the pipeline spawns `docker run` directly)   |

## Requirements

- Node.js ≥ 20 (ESM, no build step)
- Python 3 + [PyMuPDF](https://pymupdf.io/) — bootstrapped via `npm run setup`, documented in `requirements.txt`
- GROQ_API_KEY (default backend) or a Modal-hosted vLLM endpoint (`VLM_BACKEND=modal`)
- **Docker** (for `.pptx` input only): the converter runs LibreOffice headless inside a locked-down container. Host mode is supported as an escape hatch (see below)

```bash
npm install
npm run setup    # creates .venv and installs everything Python needs (≈1 dep)
cp .env.example .env   # fill in GROQ_API_KEY
npm test
```

Use `PYTHON=/path/to/python3 npm run setup` to override the interpreter (e.g. an exact
version). `.venv` is gitignored; rebuild it any time with `rm -rf .venv && npm run setup`.
If the worker complains about a missing `pymupdf` import, run `npm run setup`.

## VLM Modal Setup

The "not configured" banner in the UI means `VLLM_API_TOKEN` is empty in `.env` —
the endpoint URL is already set to the deployed Modal server. This section gets the
modal backend fully wired.

```bash
# 1) make a fresh token and save it somewhere *first* (you can't read it back):
openssl rand -hex 32

# 2) recreate the secret with the new value (delete+create; modal has no "update secret"):
python -m modal secret delete florence-api
python -m modal secret create florence-api MODAL_API_SECRET=<new-hex>

# 3) .env — add the line:
VLLM_API_TOKEN=<new-hex>

# 4) apply the new secret to the running app — secrets are read at cold boot,
#    so just wait for scale-to-zero (300 s idle) or restart the deployment:
python -m modal deploy modal/vllm_app.py      # redeploys; same app name
```

And then make sure to update the `VLM_ENDPOINT` with the output you receive as shown below.

```
VLLM_ENDPOINT_URL=https://<username>--document-vlm-8b-server.us-east.modal.direct
```

And then run the development side

```bash
npm run ui
```

Then the same verification steps as option A, plus restart the UI (`kill <pid> && npm run ui`).

**⚠ Warning:** `modal secret delete` destroys the old secret value permanently.
Double-check the new hex is saved before deleting.

### Verify the endpoint is actually serving the model

The cold path takes time. After 300 s idle Modal scales the A100 container to zero;
the first request returns `503 {"error":"no upstreams available"}` while the GPU is
being assigned. Typical timeline to ready: model load ≈ 37 s + torch.compile ≈ 74 s +
graph capture ≈ 6 s + warmup ≈ 20 s → ~3–4 min total. Poll `/health` until it
returns `200`, then retry `/v1/models`:

```bash
curl -s -m 10 https://ravijaanthony--document-vlm-8b-server.us-east.modal.direct/health
# expect: {"status":"ok",...} once warm (during boot it may answer "no upstreams available" — that's Modal, not your config)
curl -s https://ravijaanthony--document-vlm-8b-server.us-east.modal.direct/v1/models \
  -H "Authorization: Bearer $(grep -oP '^VLLM_API_TOKEN=\K.*' .env)" | python3 -m json.tool | head
```

Expected: HTTP 200 listing `Qwen/Qwen3-VL-8B-Instruct-FP8`.

### Restarting the UI

The UI reads `.env` once at process start — every `.env` edit needs a restart:

```bash
pgrep -af "node UI/server.mjs"     # find PID
kill <pid>                         # stop existing server
npm run ui                       # → http://127.0.0.1:3040
```

## Usage

```bash
node src/cli.js <file> [--out <dir>] [options]
```

Supported inputs:

- `.pdf` (born-digital or scanned)
- `.pptx` (PowerPoint — converted to PDF by LibreOffice in Docker, then processed like any other PDF; see [PowerPoint support](#powerpoint-pptx-support))
- images: `.png .jpg .jpeg .tif .tiff .webp .bmp` (wrapped as a 1-page PDF)
- PPTX decks only: `.ppt` (legacy binary) is **not** supported — re-save as `.pptx` first.

Examples:

```bash
node src/cli.js test.pdf                              # full pipeline → out/cli/<generated-name>/manifest.json
node src/cli.js test.pdf --no-figure-pass             # offline smoke test, no model calls
node src/cli.js fixtures/scanned.pdf                  # scanned pages route through the VLM path
node src/cli.js fixtures/page-one.png                 # image inputs work too
node src/cli.js fixtures/sample.pptx                  # PowerPoint (converted via LibreOffice, needs Docker)
node src/cli.js test.pdf --subject "Quarterly report" # skips LLM subject detection
node src/cli.js test.pdf --model modal                # use Modal-hosted Qwen3-VL instead of Groq
node src/cli.js test.pdf --force-vlm                  # force every page through the VLM path
```

Output:

```
<out>/manifest.json      # nested sections tree
<out>/run-report.json    # timing, token counts, validation details
```

Run folders are **self-describing** — the name tells you what produced the run:

```
<runId>_<input>_<backend>-<model>
```

- `<runId>` — 16 hex chars; keeps same-second runs of the same file unique
- `<input>` — the input file name without extension
- `<backend>-<model>` — e.g. `groq-qwen3.8-27b` or `modal-qwen3-vl-8b-instruct-fp8`
  (org prefix of the model id is dropped; `none` when running with `--model none`)

Examples:

```
out/cli/d72eb07eb531ef18_test_none/
out/ui/0b671f7bee35e952_test_groq-qwen3.8-27b/
out/ui/9f8e7d6c5b4a3210_invoice-42_modal-qwen3-vl-8b-instruct-fp8/
```

CLI runs land under `out/cli/`, UI runs under `out/ui/`. Folder names no longer
sort chronologically — use the run history sidebar (sorted by `ui-meta.json`
`created`) or `ls -t`. Whether a UI run came from a demo or a real upload is
recorded as `source` / `demo` inside `ui-meta.json`.

`run-report.json` also carries the same `run_id`. `--out <dir>` (or `options.out`)
overrides the generated folder name entirely.

## PowerPoint (.pptx) support

`.pptx` decks are converted to PDF by **LibreOffice headless inside a locked-down Docker container**, then handed to the exact same pipeline as any PDF (built-in text-layer routing, VLM figure enrichment, table detection). The upload is never trusted: it is validated as untrusted input before the converter ever runs.

### One-time setup

```bash
docker build -t pdf-parser-converter:latest docker/converter
```

That image is `debian:bookworm-slim` + `libreoffice-impress` + metric-compatible fonts (Liberation, Carlito≙Calibri, Caladea≙Cambria) — ~+450–600 MB, pinned via the distro release (bump the base image to upgrade LibreOffice deliberately). Host mode is an escape hatch for environments without Docker: install LibreOffice (`apt install libreoffice-impress`) and set `PPTX_CONVERTER=host` (`PPTX_SOFFICE_PATH=…` if not on PATH). Same flags, timeout and cleanup — no container isolation.

### What happens on every upload

1. **Validation** (`src/input/pptxValidate.js`, ~µs — never spawns LibreOffice):
   - zip signature, EOCD, central directory vs local headers (zip-quilting defense), duplicate/encrypted/symlink/path-traversal/absolute/backslash entries rejected
   - caps (all env-overridable): 25 MB file, 200 MB total / 50 MB per-entry / 25-slides / 1000 entries / 200 media files / 10000×10000 px images / 100:1 per-entry compression / 50:1 overall — actual bytes are counted while streaming inflate; declared sizes are never trusted
   - required PPTX structure (`[Content_Types].xml`, `_rels/.rels`, `ppt/presentation.xml`) — rejects renamed DOCX/XLSX/ZIPs, encrypted decks, and nested archives
   - slide count excludes hidden (`<p:sld show="0">`) and empty slides; over 25 **visible** slides → rejected before conversion
2. **Empty slides are never rendered**: the job copy (never your original) gets `show="0"` injected on shape-less slides before conversion, so LibreOffice skips them entirely — zero VLM calls wasted.
3. **Conversion** (`src/input/pptxToPdf.js`): `soffice --headless` in a per-job dir under `data/convert/<jobId>/` — no network, non-root user, read-only root fs, 1 GB memory with swap disabled, 100-PID cap, 1.5 CPUs, all capabilities dropped, `no-new-privileges`, isolated per-run profile. Default timeout **5 s** (`PPTX_CONVERT_TIMEOUT_MS`); maximum **2** simultaneous conversions (`PPTX_CONVERT_CONCURRENCY`), excess waits in queue. On timeout the whole process group is SIGKILLed (container is `docker kill`ed by cidfile). Everything is deleted in `finally`.
4. **Pipeline**: the converted PDF is analyzed like any other. Pages == visible, non-empty slides. Born-digital deck pages route to the free text-layer path; figures/charts go through VLM enrichment if configured.

The **original `.pptx` is never modified**. Converted PDFs, the input copy, and the soffice profile are deleted after the run (`out/` runs and `data/convert/` scratch are both gitignored).

`run-report.json` carries extra fields: `pptx: { total, visible, hidden, empty }` (slide counts — `pages` is always visible slides only), `errors: { vlm_page, figure_pass, subject }` (non-fatal errors — shown in the UI as a `⚠ errors ×N` chip with a hover list), `deduped_blocks`, and `validation.figures: { chart_blocks, empty_content, needs_review, estimated }` (chart health at a glance). The summary band also shows `coverage <min>%` per-page (hover lists per page). Chart blocks emitted by the VLM page path with null/flagged content are re-analyzed by the figure pass automatically; heads and captions duplicated across the text-layer and VLM paths are merged automatically. Vector drawings from one chart (bars, axes, gridlines) are clustered into a single figure region before cropping — one crop per chart.

**Graphical fidelity caveat:** chart values in the manifest are VLM estimates from rendered pixels (`estimates: true`). There is no exact-data path — LibreOffice discards native chart XML caches when rendering. Any chart whose numbers cannot be read from labeled axes is marked `content: null` + `needs_review: true` rather than invented; check `validation.figures.needs_review` and the UI's `needs_review` chips before trusting chart data.

Upload fails with a specific reason (too big, too many slides, zip bomb, encrypted, missing parts…) — shown verbatim in the UI, exit code message in the CLI. The slide cap of 25 also applies here: it counts **visible** slides only.

`GET /api/jobs` and `GET /api/jobs/:id` expose a coarse job status (`queued → converting → analyzing → done | failed`) for a future async UI. `POST /api/analyze` remains synchronous today.

**Cost note:** a born-digital deck costs zero model calls for text (figure enrichment and subject detection aside). A conversion of a typical 10-slide deck takes ~1–4 s, dominated by LibreOffice startup.

## Run the UI

```bash
npm install && npm run setup
npm run ui     # → http://127.0.0.1:3040
```

The single-page browser UI (`UI/`) exposes the whole pipeline: pick a demo
(`test.pdf` — born-digital, free; `fixtures/scanned.pdf` — scanned, calls the VLM; `fixtures/sample.pptx` — PowerPoint, converted via Docker)
or drag-and-drop your own `.pdf/.pptx/.png/.jpg/.jpeg/.tif/.tiff/.webp/.bmp`, choose the
backend (Groq vs Modal vLLM), optionally set a subject, toggle figure analysis,
figure VLM forcing, and auto-subject. Results render the full tree: headings as
nested sections, lists as real lists, tables as real `<table>`s, bar/line/pie
charts as inline SVG. `manifest.json` / `run-report.json` download from the
toolbar; runs persist in `out/ui/` under self-describing folder names (see
[Output](#output)) and show up in the run history sidebar.

Deep links: `http://127.0.0.1:3040/?run=test.pdf` pre-selects the demo (no auto-run — it spends tokens); `?run=fixtures/sample.pptx` pre-selects the PowerPoint demo (runs the Docker LibreOffice conversion).

> **Cost note:** the born-digital text path makes **zero** model calls for
> pages; figure analysis, scanned pages, and auto-subject each do. Token usage
> is printed in the UI after every run (typically ~4k in / ~900 out for the demo).

## Hosting the UI

**Single-user, localhost-only, no auth.** The server binds `127.0.0.1:3040`
(set `PORT` to change the port). Anyone with access to this machine can spend
your model quota — never expose the port, and never commit `.env`.

| Item       | Where                            | Notes                                                 |
| ---------- | -------------------------------- | ----------------------------------------------------- |
| config     | `.env` in repo root              | `GROQ_API_KEY`, `VLM_BACKEND`, optional `VLLM_*`      |
| run data   | `out/ui/`                        | UI runs (self-describing folder names) — treat as private working data; CLI runs go to `out/cli/` |
| stop       | Ctrl-C                           |                                                       |
| background | `nohup npm start >ui.log 2>&1 &` | no systemd unit ships — ops choice is yours           |

**Unverified:** reverse-proxying behind Caddy/nginx with basic auth works
mechanically but this repo ships no proxy/TLS config — treat exposure as DIY
hardening. The app itself performs no auth checks.

## Modal vLLM endpoint (optional)

Groq (the default, `VLM_BACKEND=groq`) works out of the box. For the `modal`
backend, this repo ships a ready-to-deploy **persistent vLLM server** —
`modal/vllm_app.py` (Qwen/Qwen3-VL-8B-Instruct-FP8 on one A100-40GB, scales to
zero after 300 s idle).

Deploy with the Modal CLI (needs an authenticated account with A100-40GB
entitlement):

```bash
python -m modal deploy modal/vllm_app.py
```

Prerequisites:

- `python -m modal profile list` — CLI authenticated (any account with A100-40GB entitlement)
- the `florence-api` Modal secret exists and holds `MODAL_API_SECRET`

The deploy prints two URLs:

- `…--document-vlm-8b-healthz.<region>.modal.run` — CPU-only liveness check
- `…--document-vlm-8b-server.<region>.modal.direct` — the OpenAI-compatible vLLM server

Then point the repo at the server URL, in `.env`:

```
VLM_BACKEND=modal
VLLM_ENDPOINT_URL=<the …--document-vlm-8b-server… URL, bare origin, no /v1>
VLLM_API_TOKEN=<the MODAL_API_SECRET value from the florence-api secret>
VLLM_MODEL=Qwen/Qwen3-VL-8B-Instruct-FP8 # must match --served-model-name
```

Or point it at any other OpenAI-compatible vLLM server (self-hosted box,
hosted provider) — the client is generic:

```bash
vllm serve Qwen/Qwen3-VL-8B-Instruct-FP8 --api-key "<token>" --max-model-len 16384
```

Notes:

- `VLLM_ENDPOINT_URL` takes the origin only (no `/v1`).
- The UI surfaces server errors verbatim (e.g. `Missing configuration for modal:
VLLM_ENDPOINT_URL, VLLM_API_TOKEN` shows exactly that).
- 401/403 → token mismatch with vLLM's `--api-key`. 5xx/429 → same retry
  backoff as the Groq path.
- Page images and figure crops are POSTed to the endpoint as base64 data URLs —
  host it on a trusted network only.

## Environment reference

See also [`.env.example`](.env.example). Required for the default setup: `GROQ_API_KEY`.

| Variable                                               | Required    | Default                         | Meaning                                             |
| ------------------------------------------------------ | ----------- | ------------------------------- | --------------------------------------------------- |
| `GROQ_API_KEY`                                         | for `groq`  | —                               | https://console.groq.com/keys                       |
| `GROQ_MODEL`                                           | no          | `qwen/qwen3.8-27b`              | model name passed to Groq                           |
| `VLM_BACKEND`                                          | no          | `groq`                          | `groq` or `modal`                                   |
| `VLLM_ENDPOINT_URL`                                    | for `modal` | —                               | bare origin (client appends `/v1/chat/completions`) |
| `VLLM_API_TOKEN`                                       | for `modal` | —                               | must equal vLLM `--api-key`                         |
| `VLLM_MODEL`                                           | no          | `Qwen/Qwen3-VL-8B-Instruct-FP8` | must match `--served-model-name`                    |
| `MIN_CHARS_TEXT_LAYER`                                 | no          | `80`                            | text-layer vs VLM route threshold                   |
| `DPI` / `CROP_DPI`                                     | no          | `170` / `200`                   | page render / figure crop DPI                       |
| `OUTPUT_DIR`                                           | no          | `out`                           | UI runs land under `out/ui/`, CLI runs under `out/cli/` (self-describing names) |
| `PRICE_PER_M_INPUT_TOKEN` / `PRICE_PER_M_OUTPUT_TOKEN` | no          | `0`                             | cost accounting hooks                               |

## Output schema (summary)

```jsonc
{
  "id": "doc_1a1b…",
  "subject": "Half-year financial performance summary",
  "subject_source": "auto", // user | auto | unavailable
  "source_file": "/abs/path.pdf",
  "pages": 2,
  "sections": [
    {
      "id": "s001",
      "heading": "Sample Report with Tables & Images",
      "level": 1, // 1..3 from heading font-size clusters
      "pages": [1],
      "content": [
        {
          "id": "b001",
          "type": "text",
          "page": 1,
          "content": "…",
          "needs_review": false,
        },
        // + list ({ items: [...] }), table ({ content: { columns, rows }, caption }),
        //   chart ({ chart_type, title, content, estimates }), notes
      ],
      "subsections": [/* recursive */],
    },
  ],
}
```

Tables are cell grids (never markdown). Charts carry their measured data (`x`, `series` for bar/line; `slices` for pie). Values read from pixels are marked `estimates: true`; unreadable regions set `needs_review: true`.

## How it works

1. **Normalize** — PDF accepted as-is; images wrapped as a 1-page PDF.
2. **Page analysis** — the PyMuPDF worker reads each page: text-span sizes/weights, table cells (via `find_tables` + per-cell word re-read), images, vector drawings.
3. **Route** per page: `text_chars ≥ MIN_CHARS_TEXT_LAYER AND image_cover_frac < 0.9` → text layer (baseline: **no model calls**); otherwise → VLM path.
4. **Text-layer path** — font-size clustering finds headings (≤3 levels), bullets group into lists, tables come from `find_tables`, figures are images/drawings minus table regions. Captions attach by nearest vertical gap.
5. **VLM path** — page rendered at `DPI` and transcribed with `src/prompts/page.prompt.md` (guided JSON).
6. **Figure pass** — every figure block is cropped and analyzed for `chart_type` + structured data via `src/prompts/figure.prompt.md`.
7. **Tree** — flat blocks grouped into recursive sections by heading level; reading order = page, then y, then x.
8. **Validation** — per-page text coverage vs. `text_chars`, chart series-length/pie-total checks, table column/row checks. Results go to `run-report.json`.

## Tests

```bash
npm test
```

Offline (uses the PyMuPDF worker against the committed fixtures). Figure-pass / VLM calls are **not** made during tests.

Regenerate fixtures from `test.pdf`:

```bash
node scripts/create-fixtures.mjs
```

## Environment variables

See the **Environment reference** section above and [`.env.example`](.env.example) — it is the canonical list of variables read by the code.

## Limits

- Max 25 pages per document (`MAX_PAGES` in `src/config.js`).
- English documents only.
- Born-digital text extraction depends on the PDF's text layer; scanned pages that contain no extractable text go through the VLM path.
