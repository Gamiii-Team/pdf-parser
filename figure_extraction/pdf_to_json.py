"""
Send a whole PDF straight to Modal (app `florence2-pdf-extractor`, see
`figure_extraction/florence_pdf.py`) and save the manifest-like JSON that
comes back — the same schema as the regular pipeline's manifest.json, minus
the PNG crops (nothing is written except the one JSON file you ask for).

This is a separate scenario from the crop-and-save pipeline: the PDF itself
is uploaded (base64) to the endpoint, which renders it server-side and runs
Florence-2. Detection boxes then flow through the *same* local post-processing
as the regular pipeline (caption matching, embedding filter, dedup, audit) —
so the JSON is directly comparable to a real manifest.json. The would-be
crop filenames are kept; top-level `"no_images_saved": true` marks the file.

Usage (from the repository root):

    python -m figure_extraction.pdf_to_json ./test.pdf --out ./test.pdf.json

Requires MODAL_PDF_EXTRACT_URL and MODAL_API_SECRET in the repo-root `.env`
(the URL printed by `modal deploy figure_extraction/florence_pdf.py`;
scripts/setup_modal.sh wires both). Re-rendered locally at the same DPI for
spans/crops, so geometry matches the server-side render.
"""

import argparse
import base64
import json
import os
import sys
from pathlib import Path

import requests

from figure_extraction import pipeline

REPO_ROOT = Path(__file__).resolve().parent.parent
REQUEST_TIMEOUT = 900  # seconds; the first call after deploy can cold-start
MAX_PDF_BYTES = 25 * 1024 * 1024  # must match florence_pdf.py


def get_extract_config() -> tuple[str, str]:
    """Read MODAL_PDF_EXTRACT_URL / MODAL_API_SECRET from .env. Exits with code 2 if missing."""
    from dotenv import load_dotenv

    load_dotenv(REPO_ROOT / ".env")
    url = os.environ.get("MODAL_PDF_EXTRACT_URL", "").strip()
    secret = os.environ.get("MODAL_API_SECRET", "").strip()
    missing = [
        k
        for k, v in (("MODAL_PDF_EXTRACT_URL", url), ("MODAL_API_SECRET", secret))
        if not v
    ]
    if missing:
        print(
            f"Configuration error: Missing {', '.join(missing)}. "
            "Deploy the PDF app with `python -m modal deploy figure_extraction/florence_pdf.py` "
            "(or re-run `bash scripts/setup_modal.sh`), then copy the printed "
            "MODAL_PDF_EXTRACT_URL into the repo-root .env.",
            file=sys.stderr,
        )
        raise SystemExit(2)
    return url.rstrip("/"), secret


def detect_pdf(pdf_bytes: bytes, dpi: int, phrases: str | None, url: str, secret: str) -> list:
    """POST the PDF to the endpoint and return the per-page results list."""
    body = {"pdf_b64": base64.b64encode(pdf_bytes).decode("ascii"), "dpi": dpi}
    if phrases:
        body["phrases"] = phrases
    headers = {"X-API-Secret": secret, "Content-Type": "application/json"}

    try:
        resp = requests.post(url, json=body, headers=headers, timeout=REQUEST_TIMEOUT)
    except requests.RequestException as exc:
        print(f"Error: endpoint unreachable: {exc}", file=sys.stderr)
        raise SystemExit(3)

    if resp.status_code == 401:
        print(
            "Error: the endpoint rejected the request (401 Unauthorized). Check that "
            "MODAL_API_SECRET in .env matches the value inside the `florence-api` Modal secret.",
            file=sys.stderr,
        )
        raise SystemExit(2)
    if resp.status_code != 200:
        snippet = resp.text[:300].replace("\n", " ")
        print(f"Error: endpoint returned HTTP {resp.status_code}: {snippet}", file=sys.stderr)
        raise SystemExit(4)

    try:
        payload = resp.json()
        results = payload["results"]
    except (ValueError, KeyError) as exc:
        print(f"Error: bad response from endpoint: {exc}", file=sys.stderr)
        raise SystemExit(4)
    if not isinstance(results, list):
        print("Error: bad response from endpoint: 'results' is not a list", file=sys.stderr)
        raise SystemExit(4)
    return results


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Upload a whole PDF to the florence2-pdf-extractor Modal app and save the "
                    "manifest-like JSON that comes back (no crops are written to disk)."
    )
    parser.add_argument("pdf", help="Path to the input PDF file")
    parser.add_argument("--out", default=None,
                        help="Where to write the JSON (default: ./<pdf-stem>.json in the current directory)")
    parser.add_argument("--dpi", type=int, default=200,
                        help="Render DPI used on the Modal worker (default: 200)")
    parser.add_argument("--phrases", default=None,
                        help="Override the grounding phrases sent to Florence-2")
    parser.add_argument("--debug", action="store_true",
                        help="Also print the plain-text debug summary (from the pipeline) after the run")
    args = parser.parse_args(argv)

    pdf_path = Path(args.pdf).expanduser().resolve()
    if not pdf_path.is_file():
        print(f"Error: PDF not found: {pdf_path}", file=sys.stderr)
        return 1
    pdf_bytes = pdf_path.read_bytes()
    if not pdf_bytes.startswith(b"%PDF"):
        print(f"Error: not a PDF file (missing %PDF magic): {pdf_path}", file=sys.stderr)
        return 1
    if len(pdf_bytes) > MAX_PDF_BYTES:
        print(f"Error: PDF too large ({len(pdf_bytes)} bytes > {MAX_PDF_BYTES})", file=sys.stderr)
        return 1

    url, secret = get_extract_config()
    out_path = (
        Path(args.out).expanduser().resolve()
        if args.out
        else Path.cwd() / f"{pdf_path.stem}.json"
    )

    # Sanity check: the endpoint renders the same PDF, so its results length
    # must match the local page count.
    import pymupdf

    with pymupdf.open(pdf_path) as doc:
        page_count = len(doc)

    print(f"Uploading: {pdf_path} ({page_count} pages, {len(pdf_bytes)} bytes)")
    print(f"Endpoint:  {url}")
    results = detect_pdf(pdf_bytes, args.dpi, args.phrases, url, secret)
    if len(results) != page_count:
        print(
            f"Error: page-count mismatch — endpoint returned {len(results)} result(s) for "
            f"{page_count} page(s). Refusing to guess.",
            file=sys.stderr,
        )
        return 4

    # Reuse the regular pipeline's local post-processing unchanged, with the
    # endpoint detections in place of a page-image call — and with cropping
    # switched off.
    def infer_fn(_page_pngs, _batch_size, _phrases=None):
        return results

    manifest = pipeline.process_pdf(
        pdf_path,
        out_path.parent,
        args.dpi,
        120,          # min_width
        120,          # min_height
        2.0,          # blank_stddev
        15.0,         # max_aspect_ratio
        4,            # batch_size (unused: detections already fetched)
        infer_fn=infer_fn,
        save_crops=False,
        inference_url=url,
        phrases=args.phrases,
        require_caption=True,
    )
    manifest["inference"]["url"] = url
    manifest["no_images_saved"] = True

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False))

    saved = sum(1 for c in manifest["crops"] if c["status"] == "saved")
    rejected = sum(1 for c in manifest["crops"] if c["status"] == "rejected")
    not_detected = sum(1 for c in manifest["crops"] if c["status"] == "not_detected")
    print(f"\nWrote: {out_path}")
    print(f"pages={len(manifest['pages'])} candidates={len(manifest['crops'])} "
          f"would_save={saved} rejected={rejected} not_detected={not_detected}")
    for warning in manifest.get("warnings", []):
        print(f"\n⚠️  {warning}")
    if args.debug:
        print()
        print(pipeline.debug_report(manifest))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
