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

```
index.js, src/            # existing Node.js extraction pipeline (unpdf/pdfjs)
.venv/                    # local Python virtualenv (gitignored)
.env / .env.example       # endpoint URL + API secret (.env is gitignored)
figure_extraction/        # this Python pipeline (Florence-2 on Modal)
    florence.py           # Modal app: HTTP endpoint, page image -> detections + captions
    florence_pdf.py       # second Modal app: whole PDF -> detections JSON (PDF→JSON scenario)
    pipeline.py           # CLI: render -> POST to endpoint -> crop -> validate -> manifest
    pdf_to_json.py        # CLI: upload the PDF itself -> manifest-like JSON (no crops saved)
    requirements.txt      # local Python dependencies
scripts/
    setup_modal.sh        # one-shot: secret -> deploy both apps -> .env wiring (never prints secrets)
test.pdf                  # sample PDF used in the examples below
extracted_figures/        # pipeline output (gitignored)
```

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

## How Florence-2 is used, and how outputs become crops + filenames

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
