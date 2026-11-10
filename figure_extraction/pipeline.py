"""
PDF figure/chart/table extraction pipeline.

Renders every page of a PDF to an image (PyMuPDF) and sends batches of pages
over HTTPS to the deployed Modal endpoint (`figure_extraction/florence.py`),
which runs Florence-2-large-ft for graphic detection + captioning.

Each detected region is then processed locally in a single pass over a queue:
  1. Clamped to page bounds; oversized (>80% of page area) detections rejected.
  2. Matched against literal caption lines ("Table 1: ...", "Figure 2: ...")
     found in the text layer; the crop is expanded to include the caption line.
  3. Classified by a local MiniLM embedding model as graphic vs non-graphic
     (logos/photos rejected) — or kept with a `borderline` flag.
  4. Fingerprinted (page + rounded bbox + dHash); duplicates already in the
     queue are skipped without rechecking.
  5. After the whole PDF is processed, near-identical crops are deduplicated
     (IoU / containment / dHash), keeping one image per table/figure.
  6. Kept crops are saved as .png files named after the literal caption line
     (fallback: Florence's caption, then {pdf}_p{page}_fig{i}).
  7. Caption lines found in the text layer that no detection claimed are
     reported: a warning plus a synthetic `not_detected` crop entry, so
     model grounding misses are never silent.

Every candidate — saved or rejected — is audited in manifest.json.

Usage (from the repository root):
    python -m figure_extraction.pipeline ./test.pdf \
        --output-dir ./extracted_figures --dpi 200

Configuration comes from `.env` in the repo root (copy `.env.example`):
MODAL_FLORENCE_URL and MODAL_API_SECRET are required — see README.md for how
to deploy the endpoint and wire them up. Run
`python -m figure_extraction.pipeline --help` for all options.
"""

import argparse
import base64
import hashlib
import io
import json
import os
import re
import sys
import unicodedata
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pymupdf
import requests
from PIL import Image, ImageStat
from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_VISION_MODEL = "florence-2-large"

# Prototype texts for the zero-shot graphic/non-graphic classifier
GRAPHIC_PROTOTYPES = [
    "a table",
    "a bar chart",
    "a pie chart",
    "a line graph",
    "a diagram or figure",
]
NEGATIVE_PROTOTYPES = [
    "a logo",
    "a photograph or image",
    "an icon or decorative element",
    "a page header or footer",
]

# Matches literal caption lines like "Table 1: ...", "Figure 2. ...", "Fig. 3"
CAPTION_RE = re.compile(
    r"^(table|figure|fig\.?|chart|graph|exhibit)\s*[0-9]",
    re.IGNORECASE,
)

DHASH_SIZE = 32
DHASH_MAX_DISTANCE = 8


# ---------------------------------------------------------------------------
# Filename handling
# ---------------------------------------------------------------------------

def slugify(text: str, max_len: int = 80) -> str:
    """Sanitize an arbitrary caption into a safe, recognizable filename stem."""
    text = unicodedata.normalize("NFKC", text or "").lower()
    text = re.sub(r"[^a-z0-9\s-]", "", text)
    text = re.sub(r"[\s_]+", "-", text).strip("-")
    text = re.sub(r"-{2,}", "-", text)
    if len(text) > max_len:
        cut = text[:max_len]
        # Prefer cutting at a word (hyphen) boundary to keep it recognizable.
        if "-" in cut:
            cut = cut.rsplit("-", 1)[0]
        text = cut.strip("-") or text[:max_len]
    return text


def unique_filename(stem: str, used: set) -> str:
    """Ensure uniqueness within a run by appending _2, _3, ... as needed."""
    candidate = stem
    n = 2
    while candidate in used:
        candidate = f"{stem}_{n}"
        n += 1
    used.add(candidate)
    return candidate


def fallback_stem(pdf_stem: str, page_number: int, index: int) -> str:
    return f"{pdf_stem}_p{page_number}_fig{index}"


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------

def bbox_area(b):
    x1, y1, x2, y2 = b
    return max(0.0, x2 - x1) * max(0.0, y2 - y1)


def intersection_area(a, b):
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    if ix2 <= ix1 or iy2 <= iy1:
        return 0.0
    return (ix2 - ix1) * (iy2 - iy1)


def iou(a, b):
    inter = intersection_area(a, b)
    union = bbox_area(a) + bbox_area(b) - inter
    return inter / union if union > 0 else 0.0


def containment(inner, outer):
    """Fraction of `inner` covered by `outer`."""
    area = bbox_area(inner)
    return intersection_area(inner, outer) / area if area > 0 else 0.0


def dhash(image, size=DHASH_SIZE):
    """Difference hash of an image (locality-sensitive, very fast)."""
    small = image.convert("L").resize((size + 1, size), Image.LANCZOS)
    get_flat = getattr(small, "get_flattened_data", small.getdata)
    pixels = list(get_flat())
    bits = []
    for row in range(size):
        base = row * (size + 1)
        for col in range(size):
            bits.append(1 if pixels[base + col] > pixels[base + col + 1] else 0)
    return bits  # list of bits for Hamming distance


def hamming(a, b):
    return sum(1 for x, y in zip(a, b) if x != y)


def fingerprint(page_number, bbox):
    """Stable key for a detection on a page (2px quantization)."""
    key = f"{page_number}:" + ":".join(str(int(round(v / 2))) for v in bbox)
    return hashlib.sha1(key.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Literal caption line detection (text layer, born-digital PDFs)
# ---------------------------------------------------------------------------

def find_caption_line(spans, det_bbox, max_gap_px=64):
    """
    Find the literal caption line ("Table 1: ...") closest to the detection.
    Accepts captions above or below the graphic; returns the span dict or None.
    """
    if not spans:
        return None
    x1, y1, x2, y2 = det_bbox
    best = None
    best_dist = None
    for span in spans:
        text = span["text"].strip()
        if not CAPTION_RE.match(text):
            continue
        sx0, sy0, sx1, sy1 = span["bbox"]
        # Require some horizontal overlap with the graphic (allow small margin)
        horiz = min(x2, sx1) - max(x1, sx0)
        if horiz < -20:
            continue
        if sy1 <= y1:
            dist = y1 - sy1       # caption above the graphic
        elif sy0 >= y2:
            dist = sy0 - y2       # caption below the graphic
        else:
            dist = 0              # caption inside the detection box
        if dist > max_gap_px:
            continue
        if best_dist is None or dist < best_dist:
            best, best_dist = span, dist
    return best


def expand_bbox_with_caption(det_bbox, caption_bbox, pad=6):
    x1, y1, x2, y2 = det_bbox
    sx0, sy0, sx1, sy1 = caption_bbox
    return [min(x1, sx0), max(0, min(y1, sy0 - pad)), max(x2, sx1), max(y2, sy1 + pad)]


# ---------------------------------------------------------------------------
# Embedding-based graphic/non-graphic classification (local, CPU, zero-shot)
# ---------------------------------------------------------------------------

_EMBEDDER = None
_PROTO_EMBS = None


def _get_embedder():
    global _EMBEDDER, _PROTO_EMBS
    if _EMBEDDER is None:
        from sentence_transformers import SentenceTransformer

        _EMBEDDER = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")
        _PROTO_EMBS = (
            _EMBEDDER.encode(GRAPHIC_PROTOTYPES, normalize_embeddings=True),
            _EMBEDDER.encode(NEGATIVE_PROTOTYPES, normalize_embeddings=True),
        )
    return _EMBEDDER, _PROTO_EMBS


def classify_caption(caption, margin=0.05):
    """
    Zero-shot cosine classification of the Florence caption against graphic
    and negative prototypes.

    Returns (keep: bool, verdict: str, details: dict).
    Empty captions are always kept (filename fallback handles them).
    """
    if not (caption or "").strip():
        return True, "empty_caption_keep", {"note": "no caption to classify"}

    embedder, (graph_embs, neg_embs) = _get_embedder()
    caption_emb = embedder.encode([caption], normalize_embeddings=True)[0]
    g_scores = graph_embs @ caption_emb
    n_scores = neg_embs @ caption_emb
    g_idx = int(np.argmax(g_scores))
    n_idx = int(np.argmax(n_scores))
    g_best, n_best = float(g_scores[g_idx]), float(n_scores[n_idx])
    diff = g_best - n_best

    details = {
        "graphic_score": round(g_best, 4),
        "nearest_graphic": GRAPHIC_PROTOTYPES[g_idx],
        "negative_score": round(n_best, 4),
        "nearest_negative": NEGATIVE_PROTOTYPES[n_idx],
    }
    if diff >= margin:
        return True, "graphic", details
    if diff <= -margin:
        return False, "non_graphic", details
    return True, "borderline", details


# ---------------------------------------------------------------------------
# Crop validation
# ---------------------------------------------------------------------------

def validate_crop(crop: Image.Image, min_width: int, min_height: int,
                  blank_stddev: float, max_aspect_ratio: float) -> tuple[bool, str]:
    """
    Validate a cropped region. Returns (ok, reason) where reason is "" on success.

    Checks, in order:
      1. minimum width/height
      2. extreme aspect ratio (if max_aspect_ratio > 0)
      3. mostly blank (low grayscale stddev or >=99.5% near-white pixels)
    """
    w, h = crop.size
    if w < min_width or h < min_height:
        return False, f"too_small ({w}x{h} < {min_width}x{min_height})"

    if max_aspect_ratio > 0:
        ratio = max(w, h) / max(1, min(w, h))
        if ratio > max_aspect_ratio:
            return False, f"extreme_aspect_ratio ({ratio:.2f} > {max_aspect_ratio})"

    gray = crop.convert("L")
    stat = ImageStat.Stat(gray)
    if stat.stddev[0] < blank_stddev:
        return False, f"mostly_blank (stddev={stat.stddev[0]:.2f})"

    hist = gray.histogram()  # 256 bins
    total = sum(hist)
    near_white = sum(hist[245:]) / total if total else 1.0
    if near_white >= 0.995:
        return False, f"mostly_blank (near_white={near_white:.3f})"

    return True, ""


# ---------------------------------------------------------------------------
# Page rendering
# ---------------------------------------------------------------------------

def render_pages(pdf_path: Path, dpi: int):
    """
    Yield (page_number_1_based, png_bytes, PIL.Image, text_spans) for every page.
    Spans are dicts: {"text": str, "bbox": [x0, y0, x1, y1]} in RENDER PIXELS.
    Empty spans for scanned pages without a text layer.
    """
    doc = pymupdf.open(pdf_path)
    scale = dpi / 72.0
    try:
        for i, page in enumerate(doc, start=1):
            pix = page.get_pixmap(dpi=dpi)
            png_bytes = pix.tobytes("png")
            image = Image.open(io.BytesIO(png_bytes)).convert("RGB")

            spans = []
            for block in page.get_text("dict").get("blocks", []):
                if block.get("type") != 0:  # skip image/drawing blocks
                    continue
                for line in block.get("lines", []):
                    text = "".join(s.get("text", "") for s in line.get("spans", [])).strip()
                    if not text:
                        continue
                    x0, y0, x1, y1 = line["bbox"]
                    spans.append(
                        {
                            "text": text,
                            "bbox": [x0 * scale, y0 * scale, x1 * scale, y1 * scale],
                        }
                    )
            yield i, png_bytes, image, spans
    finally:
        doc.close()


# ---------------------------------------------------------------------------
# Inference transport (HTTP -> deployed Modal endpoint)
# ---------------------------------------------------------------------------

class FlorenceConfigError(RuntimeError):
    """Missing or invalid endpoint configuration (.env)."""


class FlorenceAuthError(FlorenceConfigError):
    """Endpoint rejected our X-API-Secret."""


def get_inference_config(url_override: str | None = None) -> tuple[str, str, str]:
    """Read and validate MODAL_FLORENCE_URL / MODAL_API_SECRET / VISION_MODEL from .env.

    url_override (if given) replaces MODAL_FLORENCE_URL — used by the PDF→JSON
    scenario, whose endpoint URL lives in MODAL_PDF_EXTRACT_URL.
    """
    load_dotenv(REPO_ROOT / ".env")
    url = (url_override if url_override else os.environ.get("MODAL_FLORENCE_URL", "")).strip()
    secret = os.environ.get("MODAL_API_SECRET", "").strip()
    vision = os.environ.get("VISION_MODEL", DEFAULT_VISION_MODEL).strip() or DEFAULT_VISION_MODEL

    missing = [k for k, v in (("MODAL_FLORENCE_URL", url), ("MODAL_API_SECRET", secret)) if not v]
    if missing:
        raise FlorenceConfigError(
            f"Missing {', '.join(missing)}. Copy .env.example to .env in the repo root, deploy the "
            "endpoint with `modal deploy figure_extraction/florence.py`, then fill in MODAL_FLORENCE_URL "
            "and MODAL_API_SECRET (the README has the full setup)."
        )
    return url.rstrip("/"), secret, vision


def run_florence_on_pages(page_pngs: list[bytes], batch_size: int,
                          phrases: str | None = None) -> list:
    """
    POST batches of rendered pages to the deployed Modal endpoint and return one
    result entry per page. Entries are either a list of detections or
    {"page_error": str}.

    Chunk-level failures (unreachable endpoint, HTTP errors, bad payload) are
    recorded per page and the rest of the PDF continues to be processed —
    except HTTP 401, which means the endpoint/secret pair is misconfigured and
    the whole run stops with FlorenceAuthError.
    """
    url, secret, _vision = get_inference_config()
    headers = {"X-API-Secret": secret, "Content-Type": "application/json"}
    results: list = [None] * len(page_pngs)

    for start in range(0, len(page_pngs), batch_size):
        chunk_idx = list(range(start, min(start + batch_size, len(page_pngs))))
        body = {"images": [base64.b64encode(page_pngs[i]).decode("ascii") for i in chunk_idx]}
        if phrases:
            body["phrases"] = phrases
        try:
            resp = requests.post(url, json=body, headers=headers, timeout=600)
        except requests.RequestException as exc:
            for i in chunk_idx:
                results[i] = {"page_error": f"endpoint_unreachable: {exc}"}
            continue

        if resp.status_code == 401:
            raise FlorenceAuthError(
                "Endpoint rejected the request (401 Unauthorized). Check that MODAL_API_SECRET in "
                ".env matches the value given to `modal secret create florence-api ...`."
            )
        if resp.status_code != 200:
            snippet = resp.text[:200].replace("\n", " ")
            for i in chunk_idx:
                results[i] = {"page_error": f"http_error: {resp.status_code} {snippet}"}
            continue

        try:
            payload = resp.json()
            chunk_results = payload["results"]
        except (ValueError, KeyError) as exc:
            for i in chunk_idx:
                results[i] = {"page_error": f"bad_response: {exc}"}
            continue

        if not isinstance(chunk_results, list) or len(chunk_results) != len(chunk_idx):
            for i in chunk_idx:
                results[i] = {"page_error": "bad_response: results length mismatch"}
            continue

        for offset, entry in enumerate(chunk_results):
            results[chunk_idx[offset]] = entry
    return results


# ---------------------------------------------------------------------------
# Candidate collection (the "queue") and deduplication
# ---------------------------------------------------------------------------

def collect_candidates(pages, detections_per_page, pdf_path, min_width, min_height,
                       blank_stddev, max_aspect_ratio, keep_nongraphic, margin,
                       require_caption=True):
    """
    Walk every page's detections once, and return the queue of viable
    candidates (after clamp/oversized/caption/embedding/validation filtering).
    Every rejected candidate is appended to `records` for the audit manifest.
    """
    pdf_stem = pdf_path.stem
    records = []          # every candidate that didn't make the cut
    queue = []            # candidates waiting for the global dedup pass
    seen_fps = set()

    det_id = 0
    for (page_number, _png, image, spans), entry in zip(pages, detections_per_page):
        if entry is None:
            continue  # page-level events recorded later
        if isinstance(entry, dict) and "page_error" in entry:
            continue
        if not entry:
            continue

        page_area = image.size[0] * image.size[1]
        for det in entry:
            det_id += 1
            det_ref = f"det-{page_number}-{det_id}"
            bbox = det.get("bbox") or [0, 0, 0, 0]
            caption = (det.get("caption") or "").strip()
            label = (det.get("label") or "").strip()

            record = {
                "id": det_ref,
                "source_pdf": str(pdf_path.resolve()),
                "page": page_number,
                "bbox_detected": bbox,
                "bbox": None,
                "label": label,
                "caption": caption,
                "caption_line": None,
                "caption_found": False,
                "embedding": None,
                "confidence": None,
                "filename": None,
                "status": "rejected",
                "reason": "",
                "flags": [],
            }

            # Clamp to page bounds; manifest records the box actually used.
            w_page, h_page = image.size
            x1, y1, x2, y2 = [float(v) for v in bbox]
            x1 = max(0.0, min(x1, w_page))
            x2 = max(0.0, min(x2, w_page))
            y1 = max(0.0, min(y1, h_page))
            y2 = max(0.0, min(y2, h_page))
            bbox = [x1, y1, x2, y2]

            # 1) Oversized / degenerate box
            if bbox_area(bbox) > 0.8 * page_area:
                record.update(bbox=bbox, reason="oversized")
                record["flags"].append("oversized")
                records.append(record)
                continue
            if bbox_area(bbox) <= 0:
                record.update(bbox=bbox, reason="empty_bbox")
                records.append(record)
                continue

            # 2) Literal caption line nearby -> expand the crop to include it
            caption_line = find_caption_line(spans, bbox)
            if caption_line:
                bbox = expand_bbox_with_caption(bbox, caption_line["bbox"])
                record["caption_line"] = caption_line["text"].strip()
                record["caption_found"] = True
                record["flags"].append("caption_included")
            else:
                record["flags"].append("caption_not_found")

            record["bbox"] = bbox

            # Caption not found and captions are required → reject before heavier work
            if not caption_line and require_caption:
                record["reason"] = "caption_not_found"
                records.append(record)
                continue

            # 3) Already queued? (identical box fingerprint — never recheck)
            fp = fingerprint(page_number, bbox)
            if fp in seen_fps:
                record["reason"] = f"duplicate_fingerprint:{fp[:12]}"
                record["flags"].append("duplicate")
                records.append(record)
                continue

            # 4) Crop now (kept in queue items? no — just for validation/dHash)
            crop = image.crop((int(bbox[0]), int(bbox[1]), int(bbox[2]), int(bbox[3])))
            ok, reason = validate_crop(crop, min_width, min_height,
                                       blank_stddev, max_aspect_ratio)
            if not ok:
                record["reason"] = reason
                record["flags"].append("validation_failed")
                records.append(record)
                continue

            # 5) Embedding filter: graphic vs non-graphic
            keep, verdict, details = classify_caption(caption, margin)
            record["embedding"] = {"verdict": verdict, **details}
            if verdict == "non_graphic" and not keep_nongraphic:
                record["reason"] = f"non_graphic:{details.get('nearest_negative')}"
                record["flags"].append("non_graphic")
                records.append(record)
                continue
            if verdict == "non_graphic" and keep_nongraphic:
                record["flags"].append("non_graphic")
            if verdict == "borderline":
                record["flags"].append("borderline")

            item = dict(record)
            item["dhash"] = dhash(crop)
            item["fingerprint"] = fp
            item["status"] = "queued"
            seen_fps.add(fp)
            queue.append(item)

    return queue, records


def normalize_caption_key(text):
    """Normalize a literal caption line into a stable grouping key."""
    t = unicodedata.normalize("NFKC", text or "").lower()
    t = re.sub(r"[^a-z0-9]+", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def reconcile_captions(caption_lines, crops, pdf_path):
    """
    Cross-check caption lines found in the text layer against the captions
    claimed by detections (saved or rejected). Caption lines no detection
    anchored to — i.e. likely model grounding misses — are reported as
    warnings and synthetic `not_detected` crop entries.

    caption_lines: list of (page_number, caption_line_text).
    crops:         the manifest crop entries collected so far.
    Returns (warnings, records).
    """
    claimed = set()
    for crop in crops:
        cl = crop.get("caption_line")
        if cl:
            claimed.add((crop.get("page"), normalize_caption_key(cl)))

    warnings, records = [], []
    seen = set()
    n = 0
    for page_number, text in caption_lines:
        key = (page_number, normalize_caption_key(text))
        if key in claimed or key in seen:
            continue
        seen.add(key)
        n += 1
        warnings.append(
            f'unmatched_caption: "{text}" (page {page_number}) — no detection was anchored to '
            "this caption; the model likely missed the graphic (common for borderless tables)."
        )
        records.append({
            "id": f"caption-{page_number}-{n}",
            "source_pdf": str(pdf_path.resolve()),
            "page": page_number,
            "bbox": None,
            "bbox_detected": None,
            "label": None,
            "caption": "",
            "caption_line": text,
            "caption_found": True,
            "embedding": None,
            "confidence": None,
            "filename": None,
            "status": "not_detected",
            "reason": "caption_not_detected",
            "flags": ["caption_undetected"],
        })
    return warnings, records


def dedupe_queue(queue, iou_threshold):
    """
    Collapse near-identical boxes in the queue (same page), in two passes:

      1. Caption-key pass — boxes anchored to the same literal caption line
         are the same graphic by definition. Keep the largest box.
      2. Spatial pass — IoU / containment / dHash for the rest.

    Rejected boxes are tagged `duplicate_caption_key:<id>` / `duplicate_of:<id>`.
    """
    def priority(item):
        return (bbox_area(item["bbox"]), len(item.get("caption") or ""))

    duplicates = []

    # ---- Pass 1: caption-key grouping (same page + same caption line) ----
    buckets = {}
    for item in queue:
        cl = item.get("caption_line")
        if cl:
            buckets.setdefault((item["page"], normalize_caption_key(cl)), []).append(item)

    removed = set()
    for (page, key), items in buckets.items():
        if len(items) <= 1:
            continue
        best = max(items, key=priority)
        for item in items:
            if item is best:
                continue
            item = dict(item)
            item["status"] = "rejected"
            item["reason"] = f"duplicate_caption_key:{best['id']}"
            item["flags"] = list(item.get("flags", [])) + ["duplicate"]
            duplicates.append(item)
            removed.add(item["id"])
    survivors = [i for i in queue if i["id"] not in removed]

    # ---- Pass 2: spatial dedup on the survivors (same page) ----
    def spatial_rank(i):
        return (bool(i.get("caption_found")),) + priority(i)

    order = sorted(survivors, key=spatial_rank, reverse=True)
    kept = []
    for item in order:
        dup = None
        for k in kept:
            if k["page"] != item["page"]:
                continue
            overlap = iou(item["bbox"], k["bbox"])
            contained = containment(item["bbox"], k["bbox"])
            similar_pixels = hamming(item["dhash"], k["dhash"]) <= DHASH_MAX_DISTANCE
            if overlap > iou_threshold or contained > 0.8 or similar_pixels:
                dup = k
                break
        if dup is None:
            kept.append(item)
        else:
            item = dict(item)
            item["status"] = "rejected"
            item["reason"] = f"duplicate_of:{dup['id']}"
            item["flags"] = list(item.get("flags", [])) + ["duplicate"]
            duplicates.append(item)

    kept_ids = {k["id"] for k in kept}
    kept = [item for item in queue if item["id"] in kept_ids]
    return kept, duplicates


def debug_report(manifest) -> str:
    """
    Plain-text debug summary of what the model detected vs. what it missed.
    Printed to stdout only when --debug is passed; changes nothing else.
    """
    crops = manifest.get("crops", [])
    pages = manifest.get("pages", [])

    raw = [c for c in crops if c.get("bbox_detected") is not None]
    synth = [c for c in crops if c.get("status") == "not_detected"]
    saved = [c for c in crops if c.get("status") == "saved"]
    rejected = [c for c in crops if c.get("status") == "rejected"]

    page_ok = sum(1 for p in pages if p.get("status") == "ok")
    page_err = sum(1 for p in pages if p.get("status") == "error")
    page_none = sum(1 for p in pages if p.get("status") == "no_detections")

    lines = ["=== DEBUG DETECTION SUMMARY ==="]
    lines.append(f"model: {manifest.get('model')}   dpi: {manifest.get('dpi')}   "
                 f"pages: {len(pages)} (ok={page_ok} errors={page_err} no_detections={page_none})")
    lines.append("")

    lines.append("MODEL DETECTIONS (raw, before filtering; excludes not_detected placeholders)")
    lines.append(f"  total: {len(raw)}")
    if raw:
        by_label = Counter((c.get("label") or "(unlabeled)").strip().lower() or "(unlabeled)" for c in raw)
        lines.append("  by label: " + ", ".join(
            f"{k}: {v}" for k, v in sorted(by_label.items(), key=lambda kv: (-kv[1], kv[0]))))
        by_page = Counter(c.get("page") for c in raw)
        lines.append("  by page:  " + ", ".join(f"page {k}: {v}" for k, v in sorted(by_page.items())))
    lines.append("")

    anchored = sum(1 for c in raw if c.get("caption_line"))
    claimed = {(c.get("page"), normalize_caption_key(c["caption_line"]))
               for c in raw if c.get("caption_line")}
    lines.append("CAPTION ANCHORING")
    lines.append(f"  detections anchored to a caption line: {anchored}")
    lines.append(f"  detections with no nearby caption:     {len(raw) - anchored}")
    lines.append(f"  caption lines found in text layer:     {manifest.get('caption_lines_found', 0)}")
    lines.append(f"  captions claimed by a detection:       {len(claimed)}")
    lines.append(f"  captions not detected (model miss):    {len(synth)}")
    for c in synth:
        lines.append(f"    - {c.get('caption_line')} (page {c.get('page')})")
    lines.append("")

    lines.append("OUTCOME")
    lines.append(f"  saved: {len(saved)}   rejected: {len(rejected)}   not_detected: {len(synth)}")
    if rejected:
        by_reason = Counter((c.get("reason") or "unknown").split(":", 1)[0] for c in rejected)
        for reason, n in sorted(by_reason.items(), key=lambda kv: (-kv[1], kv[0])):
            lines.append(f"    rejected {reason}: {n}")
    lines.append("")

    lines.append("SAVED FILES BY CAPTION TYPE")
    if saved:
        by_type = Counter((c.get("caption_line") or "").strip().split(" ", 1)[0].lower() or "(no caption)"
                          for c in saved)
        for ctype, n in sorted(by_type.items()):
            lines.append(f"  {ctype}: {n}")
        lines.append("  files:")
        for c in saved:
            lines.append(f"    {c.get('filename')}   [model label: {c.get('label') or '?'}]   "
                         f"{c.get('caption_line') or '(no caption line)'}")
    else:
        lines.append("  (none)")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

def process_pdf(pdf_path: Path, output_dir: Path, dpi: int, min_width: int,
                min_height: int, blank_stddev: float, max_aspect_ratio: float,
                batch_size: int, keep_nongraphic: bool = False,
                margin: float = 0.05, iou_threshold: float = 0.6,
                require_caption: bool = True,
                infer_fn=None, save_crops: bool = True,
                inference_url: str | None = None,
                phrases: str | None = None) -> dict:
    if infer_fn is None:
        infer_fn = run_florence_on_pages
    url, _secret, vision = get_inference_config(inference_url)  # fail fast before rendering

    pdf_stem = pdf_path.stem
    run_dir = output_dir / pdf_stem
    if save_crops:
        run_dir.mkdir(parents=True, exist_ok=True)

    manifest = {
        "schema_version": 3,
        "source_pdf": str(pdf_path.resolve()),
        "model": vision,
        "dpi": dpi,
        "inference": {"transport": "http", "url": url},
        "created_at": datetime.now(timezone.utc).isoformat(),
        "output_dir": str(run_dir.resolve()),
        "pages": [],   # per-page events: ok / no_detections / error
        "crops": [],   # every candidate: saved or rejected
        "caption_lines_found": 0,
        "warnings": [],
    }
    if not save_crops:
        manifest["no_images_saved"] = True

    # Render everything first so Modal can be called in batches.
    pages: list[tuple[int, bytes, Image.Image, list]] = []
    try:
        for page_number, png_bytes, image, spans in render_pages(pdf_path, dpi):
            pages.append((page_number, png_bytes, image, spans))
    except Exception as exc:
        manifest["pages"].append({"page": None, "status": "error", "error": f"render_failed: {exc}"})
        return manifest

    if not pages:
        manifest["pages"].append({"page": None, "status": "error", "error": "pdf_has_no_pages"})
        return manifest

    caption_lines = []
    for page_number, _png, _image, spans in pages:
        for span in spans:
            text = span["text"].strip()
            if CAPTION_RE.match(text):
                caption_lines.append((page_number, text))
    caption_lines_total = len(caption_lines)
    manifest["caption_lines_found"] = caption_lines_total
    if require_caption and caption_lines_total == 0:
        manifest["warnings"].append(
            "no_caption_lines_found: document appears to be scanned (no caption lines in the text "
            "layer); every detection will be rejected as caption_not_found. Re-run with "
            "--allow-uncaptioned to keep captionless graphics."
        )

    page_pngs = [p[1] for p in pages]
    detections_per_page = infer_fn(page_pngs, batch_size, phrases)

    # Per-page event records (ok / no_detections / error)
    for (page_number, _png, _image, _spans), entry in zip(pages, detections_per_page):
        if entry is None:
            manifest["pages"].append(
                {"page": page_number, "status": "error", "error": "no_result_from_modal"})
        elif isinstance(entry, dict) and "page_error" in entry:
            manifest["pages"].append(
                {"page": page_number, "status": "error", "error": entry["page_error"]})
        elif not entry:
            manifest["pages"].append({"page": page_number, "status": "no_detections"})
        else:
            manifest["pages"].append(
                {"page": page_number, "status": "ok", "detections": len(entry)})

    # Candidate collection ("the queue") — single pass over the PDF
    queue, rejected = collect_candidates(
        pages, detections_per_page, pdf_path, min_width, min_height,
        blank_stddev, max_aspect_ratio, keep_nongraphic, margin,
        require_caption=require_caption)

    # Whole-document dedup (the queue is now processed against itself)
    kept, duplicates = dedupe_queue(queue, iou_threshold)
    rejected.extend(duplicates)

    page_map = {page_number: image for page_number, _png, image, _spans in pages}

    used_names: set = set()
    for index, item in enumerate(kept, start=1):
        page_number = item["page"]
        x1, y1, x2, y2 = item["bbox"]
        crop = page_map[page_number].crop((int(x1), int(y1), int(x2), int(y2)))

        caption_line = (item.get("caption_line") or "").strip()
        caption = (item.get("caption") or "").strip()
        stem = slugify(caption_line) or slugify(caption)
        if not stem:
            stem = fallback_stem(pdf_stem, page_number, index)
            item["flags"].append("fallback_filename")
        elif len(stem) < 4:
            item["flags"].append("short_caption_stem")

        final_stem = unique_filename(stem, used_names)
        if final_stem != stem:
            item["flags"].append("deduplicated_filename")

        filename = f"{final_stem}.png"
        if save_crops:
            crop.save(run_dir / filename)
        item = dict(item)
        item.pop("dhash", None)
        item.pop("fingerprint", None)
        item.update(filename=filename, status="saved", reason="")
        manifest["crops"].append(item)

    for item in rejected:
        item = dict(item)
        item.pop("dhash", None)
        item.pop("fingerprint", None)
        manifest["crops"].append(item)

    # Reconcile caption lines found in the text layer against claimed captions.
    # Any caption no detection anchored to is a silent grounding miss — report it.
    recon_warnings, recon_records = reconcile_captions(caption_lines, manifest["crops"], pdf_path)
    manifest["warnings"].extend(recon_warnings)
    manifest["crops"].extend(recon_records)

    return manifest


def main(argv=None):
    parser = argparse.ArgumentParser(description="Extract figures/charts/tables from a PDF using Florence-2 (Modal).")
    parser.add_argument("pdf", help="Path to the input PDF file")
    parser.add_argument("--output-dir", default="./extracted_figures",
                        help="Directory for cropped images and the manifest (default: ./extracted_figures)")
    parser.add_argument("--dpi", type=int, default=200, help="Render DPI (default: 200)")
    parser.add_argument("--min-width", type=int, default=120, help="Reject crops narrower than this (px)")
    parser.add_argument("--min-height", type=int, default=120, help="Reject crops shorter than this (px)")
    parser.add_argument("--blank-stddev", type=float, default=2.0,
                        help="Reject crops whose grayscale stddev is below this (default: 2.0)")
    parser.add_argument("--max-aspect-ratio", type=float, default=15.0,
                        help="Reject crops wider/taller than this ratio; 0 disables (default: 15)")
    parser.add_argument("--batch-size", type=int, default=4, help="Pages per Modal call (default: 4)")
    parser.add_argument("--phrases", default=None, help="Override the grounding phrases sent to Florence-2")
    parser.add_argument("--keep-nongraphic", action="store_true",
                        help="Keep detections classified as logos/photos (flagged non_graphic) instead of rejecting")
    parser.add_argument("--margin", type=float, default=0.05,
                        help="Cosine margin for the graphic/non-graphic decision (default: 0.05; lower keeps more)")
    parser.add_argument("--iou", type=float, default=0.6,
                        help="IoU above which two boxes on a page are treated as the same graphic (default: 0.6)")
    parser.add_argument("--allow-uncaptioned", action="store_true",
                        help="Keep graphics that have no literal caption line (e.g. scanned PDFs). "
                             "By default, every detected graphic must be anchored to a caption line "
                             "(Table 1:, Figure 2: ...) or it is rejected as caption_not_found.")
    parser.add_argument("--debug", action="store_true",
                        help="After the run, print a plain-text debug summary of what the model "
                             "detected vs. missed (inspection only; changes nothing else)")
    args = parser.parse_args(argv)

    pdf_path = Path(args.pdf).expanduser().resolve()
    if not pdf_path.is_file():
        print(f"Error: PDF not found: {pdf_path}", file=sys.stderr)
        return 1

    output_dir = Path(args.output_dir).expanduser().resolve()

    # Fail fast on missing/invalid endpoint config before doing any work.
    try:
        get_inference_config()
    except FlorenceConfigError as exc:
        print(f"Configuration error: {exc}", file=sys.stderr)
        return 2

    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"Rendering and analyzing: {pdf_path}")
    print(f"Output directory:        {output_dir}")

    try:
        manifest = process_pdf(pdf_path, output_dir, args.dpi, args.min_width,
                               args.min_height, args.blank_stddev,
                               args.max_aspect_ratio, args.batch_size,
                               keep_nongraphic=args.keep_nongraphic,
                               margin=args.margin,
                               iou_threshold=args.iou,
                               require_caption=not args.allow_uncaptioned,
                               phrases=args.phrases)
    except FlorenceConfigError as exc:
        print(f"Configuration error: {exc}", file=sys.stderr)
        return 2

    manifest_path = output_dir / pdf_path.stem / "manifest.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False))

    saved = sum(1 for c in manifest["crops"] if c["status"] == "saved")
    rejected = sum(1 for c in manifest["crops"] if c["status"] == "rejected")
    not_detected = sum(1 for c in manifest["crops"] if c["status"] == "not_detected")
    errors = sum(1 for p in manifest["pages"] if p["status"] == "error")
    no_det = sum(1 for p in manifest["pages"] if p["status"] == "no_detections")

    print(f"\nDone. saved={saved} rejected={rejected} not_detected={not_detected} pages_no_detections={no_det} page_errors={errors}")
    print(f"Manifest: {manifest_path}")
    for warning in manifest.get("warnings", []):
        print(f"\n⚠️  {warning}")
    if args.debug:
        print()
        print(debug_report(manifest))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
