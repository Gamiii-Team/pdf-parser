"""
Modal app: whole PDF in -> Florence-2 detections out, as an HTTP endpoint.

Sibling of `florence2-figure-extractor` (`figure_extraction/florence.py`).
This app exists so a caller can post a whole PDF and get per-page detection
JSON back without any local rendering dependencies — e.g. as a thin client.
It is intentionally a separate Modal app; it shares nothing but the
`florence-api` Modal secret (same MODAL_API_SECRET).

Deploy with:

    python -m modal deploy figure_extraction/florence_pdf.py

The deploy prints the endpoint URL — save it in the repo-root `.env` as
MODAL_PDF_EXTRACT_URL (scripts/setup_modal.sh does this automatically).
Every request must carry the header `X-API-Secret: <MODAL_API_SECRET>`;
/healthz is unauthenticated.

What happens inside `POST /`, per page of the uploaded PDF:

  1. PyMuPDF renders the page in memory at the requested DPI (nothing hits disk).
  2. `<CAPTION_TO_PHRASE_GROUNDING>` with graphic-related phrases
     -> bounding boxes + phrase labels.
  3. Each grounded box is cropped from the page image.
  4. `<MORE_DETAILED_CAPTION>` on the crop -> a descriptive caption string.

Request JSON:
    {"pdf_b64": "<base64 PDF>", "dpi": 200, "phrases": "<optional override>"}

Response JSON (200):
    {"model": "microsoft/Florence-2-large-ft", "dpi": 200, "pages": <n>,
     "results": [ [{bbox, label, caption}] | {"page_error": str}, ... ]}

`results[i]` corresponds to page `i+1` of the PDF. A failed page yields a
dict with "page_error" instead of a list, so one bad page never fails the
whole upload. Cropping, validation, caption matching, embedding filtering and
dedup are NOT done here — the caller (e.g. `figure_extraction/pdf_to_json.py`)
reuses the local post-processing in `figure_extraction/pipeline.py` on the
returned detections.

NOTE: the Florence-2 model code below is intentionally duplicated from
figure_extraction/florence.py so this app deploys standalone. Keep the two
in sync when changing prompts, model ids, or generation parameters.
"""

import base64
import io
import os

import fastapi
import modal

app = modal.App("florence2-pdf-extractor")

# Same GPU shape and deps as the sibling app, plus PyMuPDF for server-side
# PDF rendering. No local python source is mounted into the image.
image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "torch",
        "transformers==4.49.0",
        "timm",
        "einops",
        "packaging",
        "pillow",
        "fastapi",
        "pymupdf",
    )
)

DEFAULT_VISION_MODEL = "florence-2-large"

# Phrases used for <CAPTION_TO_PHRASE_GROUNDING>. Florence-2 expects phrases
# separated by periods inside the prompt text.
GRAPHIC_PHRASES = (
    "figure . chart . graph . diagram . table . "
    "pie chart . bar chart . line chart . scatter plot . flowchart"
)

MAX_PDF_BYTES = 25 * 1024 * 1024  # 25 MB
MIN_DPI, MAX_DPI = 72, 400

_MODEL = None


# --- Florence-2 model code (keep in sync with figure_extraction/florence.py) --

def _resolve_model_id(vision_model: str) -> str:
    """Map `florence-2-large` -> `microsoft/Florence-2-large-ft` (accepts full ids too)."""
    vm = (vision_model or DEFAULT_VISION_MODEL).strip()
    return vm if "/" in vm else f"microsoft/{vm}-ft"


def _load_model():
    """Lazy-load Florence-2 once per warm container."""
    global _MODEL
    if _MODEL is not None:
        return _MODEL

    import torch
    from transformers import AutoModelForCausalLM, AutoProcessor

    model_id = _resolve_model_id(os.environ.get("VISION_MODEL", DEFAULT_VISION_MODEL))
    # Pin the exact large-ft commit we downloaded; skip the pin for other models
    model_revision = (
        "4a12a2b54b7016a48a22037fbd62da90cd566f2a" if "large-ft" in model_id else None
    )
    processor = AutoProcessor.from_pretrained(
        model_id, trust_remote_code=True, revision=model_revision
    )
    model = AutoModelForCausalLM.from_pretrained(
        model_id,
        torch_dtype=torch.float16,
        trust_remote_code=True,
        revision=model_revision,
    ).to("cuda").eval()
    _MODEL = (processor, model, torch, model_id)
    return _MODEL


def _run_task(processor, model, torch, image, task, text=None):
    prompt = task if text is None else f"{task}{text}"
    inputs = processor(text=prompt, images=image, return_tensors="pt").to(
        "cuda", torch.float16
    )
    with torch.no_grad():
        ids = model.generate(
            **inputs,
            max_new_tokens=1024,
            num_beams=3,
            do_sample=False,
        )
    raw = processor.batch_decode(ids, skip_special_tokens=False)[0]
    return processor.post_process_generation(raw, task=task, image_size=image.size)


def _detect_and_caption_one(processor, model, torch, page_png: bytes, phrases: str) -> list[dict]:
    """Run grounding + per-region captioning on one rendered page."""
    from PIL import Image

    page_image = Image.open(io.BytesIO(page_png)).convert("RGB")
    page_w, page_h = page_image.size

    ground = _run_task(
        processor, model, torch, page_image,
        "<CAPTION_TO_PHRASE_GROUNDING>", phrases,
    )
    ground_data = ground.get("<CAPTION_TO_PHRASE_GROUNDING>", {}) or {}
    bboxes = ground_data.get("bboxes", []) or []
    labels = ground_data.get("labels", []) or []

    detections = []
    for bbox, label in zip(bboxes, labels):
        # Clamp to page bounds; Florence-2 can emit slightly out-of-range boxes.
        x1, y1, x2, y2 = [float(v) for v in bbox]
        x1 = max(0.0, min(x1, page_w - 1))
        y1 = max(0.0, min(y1, page_h - 1))
        x2 = max(0.0, min(x2, page_w))
        y2 = max(0.0, min(y2, page_h))
        if x2 - x1 < 4 or y2 - y1 < 4:
            continue

        crop = page_image.crop((int(x1), int(y1), int(x2), int(y2)))
        caption_out = _run_task(
            processor, model, torch, crop, "<MORE_DETAILED_CAPTION>",
        )
        caption = (caption_out.get("<MORE_DETAILED_CAPTION>") or "").strip()

        detections.append(
            {
                "bbox": [x1, y1, x2, y2],
                "label": (label or "").strip(),
                "caption": caption,
            }
        )
    return detections


# --- PDF handling (this app only) ---------------------------------------------

def _render_pdf_pages(pdf_bytes: bytes, dpi: int):
    """Yield (page_number_1_based, png_bytes) for every page, from memory."""
    import pymupdf

    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    try:
        for i, page in enumerate(doc, start=1):
            pix = page.get_pixmap(dpi=dpi)
            yield i, pix.tobytes("png")
    finally:
        doc.close()


@app.function(
    gpu="T4",
    image=image,
    timeout=900,
    scaledown_window=300,
    secrets=[modal.Secret.from_name("florence-api")],
)
@modal.fastapi_endpoint(method="POST")
async def extract_pdf(request: fastapi.Request):
    secret = os.environ.get("MODAL_API_SECRET")
    if not secret:
        return fastapi.responses.JSONResponse(
            {"error": "server misconfigured: MODAL_API_SECRET not set"}, status_code=500
        )
    if request.headers.get("x-api-secret") != secret:
        return fastapi.responses.JSONResponse({"error": "unauthorized"}, status_code=401)

    try:
        body = await request.json()
    except Exception:
        return fastapi.responses.JSONResponse({"error": "invalid JSON body"}, status_code=400)

    pdf_b64 = body.get("pdf_b64")
    if not isinstance(pdf_b64, str) or not pdf_b64.strip():
        return fastapi.responses.JSONResponse(
            {"error": 'body must contain "pdf_b64": base64-encoded PDF bytes'},
            status_code=400,
        )
    try:
        pdf_bytes = base64.b64decode(pdf_b64, validate=True)
    except Exception:
        return fastapi.responses.JSONResponse({"error": "pdf_b64 is not valid base64"}, status_code=400)
    if not pdf_bytes.startswith(b"%PDF"):
        return fastapi.responses.JSONResponse(
            {"error": "payload is not a PDF (missing %PDF magic bytes)"}, status_code=400
        )
    if len(pdf_bytes) > MAX_PDF_BYTES:
        return fastapi.responses.JSONResponse(
            {"error": f"PDF too large ({len(pdf_bytes)} bytes > {MAX_PDF_BYTES})"},
            status_code=413,
        )

    dpi = body.get("dpi", 200)
    try:
        dpi = int(dpi)
    except (TypeError, ValueError):
        return fastapi.responses.JSONResponse({"error": "dpi must be an integer"}, status_code=400)
    if dpi < MIN_DPI or dpi > MAX_DPI:
        return fastapi.responses.JSONResponse(
            {"error": f"dpi must be between {MIN_DPI} and {MAX_DPI}"}, status_code=400
        )

    phrases = body.get("phrases") or GRAPHIC_PHRASES

    processor, model, torch, model_id = _load_model()
    results: list = []
    page_count = 0
    try:
        for page_number, page_png in _render_pdf_pages(pdf_bytes, dpi):
            page_count += 1
            try:
                results.append(_detect_and_caption_one(processor, model, torch, page_png, phrases))
            except Exception as exc:  # per-page isolation: one bad page must not kill the upload
                results.append({"page_error": str(exc)})
    except Exception as exc:
        return fastapi.responses.JSONResponse(
            {"error": f"failed to render the uploaded PDF: {exc}"}, status_code=400
        )

    if page_count == 0:
        return fastapi.responses.JSONResponse({"error": "the PDF has no pages"}, status_code=400)

    return {"model": model_id, "dpi": dpi, "pages": page_count, "results": results}


@app.function(image=image, timeout=30)
@modal.fastapi_endpoint(method="GET")
def healthz():
    return {"status": "ok"}
