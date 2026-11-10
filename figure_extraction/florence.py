"""
Modal app: Florence-2 graphic detection + captioning as an HTTP endpoint.

Deploy with:
    modal deploy figure_extraction/florence.py

The deploy prints the endpoint URL — save it in the repo-root `.env` as
`MODAL_FLORENCE_URL`, and set `MODAL_API_SECRET` to the same value given to
the Modal secret (see README.md):

    openssl rand -hex 32                      # generate once
    modal secret create florence-api \
        MODAL_API_SECRET=<that value> \
        VISION_MODEL=florence-2-large

Every request must carry the header `X-API-Secret: <MODAL_API_SECRET>`;
otherwise the endpoint responds 401. `/healthz` is unauthenticated.

What happens inside `POST /`, per page image (single round trip per page
list, no per-page calls from the client):

  1. `<CAPTION_TO_PHRASE_GROUNDING>` with graphic-related phrases
     ("figure . chart . ...") -> bounding boxes + phrase labels.
  2. Each grounded box is cropped from the page image.
  3. `<MORE_DETAILED_CAPTION>` on the crop -> a descriptive caption string.

Request JSON:
    {"images": ["<base64 PNG>", ...], "phrases": "<optional override>"}

Response JSON (200):
    {"model": "microsoft/Florence-2-large-ft",
     "results": [ [{bbox, label, caption}] | {"page_error": str}, ... ]}

`results[i]` corresponds to `images[i]`. A failed page yields a dict with
"page_error" instead of a list, so one bad page never fails the whole batch.
Florence-2 exposes no per-box confidence through these tasks, so none is
returned; callers should surface validation flags instead.
"""

import base64
import io
import os

import fastapi
import modal

app = modal.App("florence2-figure-extractor")

# GPU: Florence-2-large-ft (~0.77B params, fp16) fits on a T4.
# The model is downloaded from the Hugging Face hub on first cold start and
# cached in the warm container via the lazy global below.
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
    )
)

DEFAULT_VISION_MODEL = "florence-2-large"

# Phrases used for <CAPTION_TO_PHRASE_GROUNDING>. Florence-2 expects phrases
# separated by periods inside the prompt text.
GRAPHIC_PHRASES = (
    "figure . chart . graph . diagram . table . "
    "pie chart . bar chart . line chart . scatter plot . flowchart"
)

MAX_IMAGES_PER_REQUEST = 16

_MODEL = None


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


def _analyze_pages(pages_b64: list, phrases: str) -> tuple[list, str]:
    """Decode base64 page images, run inference with per-page error isolation."""
    processor, model, torch, model_id = _load_model()
    results = []
    for item in pages_b64:
        try:
            page_png = base64.b64decode(item, validate=True)
            if not page_png:
                raise ValueError("empty image payload")
            results.append(_detect_and_caption_one(processor, model, torch, page_png, phrases))
        except Exception as exc:  # per-page isolation: one bad page must not kill the batch
            results.append({"page_error": str(exc)})
    return results, model_id


@app.function(
    gpu="T4",
    image=image,
    timeout=900,
    scaledown_window=300,
    secrets=[modal.Secret.from_name("florence-api")],
)
@modal.fastapi_endpoint(method="POST")
async def detect(request: fastapi.Request):
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

    images = body.get("images")
    if not isinstance(images, list) or not images:
        return fastapi.responses.JSONResponse(
            {"error": 'body must contain a non-empty "images" list of base64-encoded page PNGs'},
            status_code=400,
        )
    if len(images) > MAX_IMAGES_PER_REQUEST:
        return fastapi.responses.JSONResponse(
            {"error": f"too many images ({len(images)} > {MAX_IMAGES_PER_REQUEST})"},
            status_code=413,
        )

    phrases = body.get("phrases") or GRAPHIC_PHRASES
    results, model_id = _analyze_pages(images, phrases)
    return {"model": model_id, "results": results}


@app.function(image=image, timeout=30)
@modal.fastapi_endpoint(method="GET")
def healthz():
    return {"status": "ok"}
