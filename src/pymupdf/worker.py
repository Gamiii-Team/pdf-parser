#!/usr/bin/env python3
"""PyMuPDF-backed worker. Commands:

  analyze <pdf>              -> single JSON: whole doc (pages, spans, tables, images)
  crop    <pdf> <page> <x0> <y0> <x1> <y1> <dpi> <out.png>
  render  <pdf> <page> <dpi> <out.png>

Stdin/stdout JSON in and out. Spans are list of <text-block> structures:
{block_index, line_index, bbox, text, spans: [{text, fontSize, bold, bbox}]}.
"""
import argparse
import json
import os
import sys
import pymupdf

MAX_PAGES = 25


def load_doc(path):
    return pymupdf.open(path)


def _word_bbox(w):
    # pymupdf "words" tuples: (x0, y0, x1, y1, text, block, line, word)
    return [float(w[0]), float(w[1]), float(w[2]), float(w[3])]


def _col_edges_from_find_tables(table):
    """Return column x-boundaries (left edges + one past the last) in page coords."""
    try:
        cells = table.extract() or []
        if not cells:
            return None
        # infer column edges from cell bboxes in the table's internal layout
        hdr = getattr(table, "header", None)
        if hdr is not None:
            cells_attr = getattr(hdr, "cells", None)
            if cells_attr:
                xs = [float(c[0]) for c in cells_attr if isinstance(c, (list, tuple)) and len(c) >= 1]
                xs += [float(c[2]) for c in cells_attr if isinstance(c, (list, tuple)) and len(c) >= 3]
                if xs:
                    return sorted(set(round(v, 1) for v in xs))
    except Exception:
        pass
    return None


def get_tables(page):
    tables = []
    try:
        raw = list(page.find_tables())
    except Exception:
        return tables
    for t in raw:
        try:
            bbox = getattr(t, "bbox", None)
            if isinstance(bbox, tuple):
                bb = list(bbox)
            else:
                bb = [bbox.x0, bbox.y0, bbox.x1, bbox.y1] if bbox else None
            if not bb:
                continue
            # Get the cells back from find_tables for column count, then re-read words for text fidelity
            raw_cells = t.extract() or []
            if not raw_cells:
                continue
            n_rows = len(raw_cells)
            n_cols = max((len(r) if r else 0) for r in raw_cells)
            # Re-read text within the table bbox via words (preserves spaces)
            words = page.get_text("words", clip=pymupdf.Rect(*bb)) or []
            # row-cluster by y0; col-cluster by x-centers
            if not words:
                cells = [[(c or "").strip() for c in row] for row in raw_cells]
            else:
                rows = []
                buf_y = []
                buf_words = []
                sorted_words = sorted(words, key=lambda w: (float(w[1]), float(w[0])))
                for w in sorted_words:
                    y0, y1 = float(w[1]), float(w[3])
                    if not buf_y:
                        buf_y = [y0, y1]
                        buf_words = [w]
                        continue
                    if y0 <= buf_y[1] + 3:
                        buf_y[0] = min(buf_y[0], y0); buf_y[1] = max(buf_y[1], y1)
                        buf_words.append(w)
                        continue
                    rows.append((buf_y[0], buf_y[1], sorted(buf_words, key=lambda w: float(w[0]))))
                    buf_y = [y0, y1]; buf_words = [w]
                if buf_words:
                    rows.append((buf_y[0], buf_y[1], sorted(buf_words, key=lambda w: float(w[0]))))
                # Split each row into columns by x-gap (>10pt between clusters)
                col_count_guess = n_cols
                grid_rows = []
                for (y0, y1, ws) in rows:
                    # merge words into contiguous cells separated by big x gaps
                    cells_out = []
                    cur = []
                    last_x1 = None
                    for w in ws:
                        x0, x1 = float(w[0]), float(w[2])
                        if last_x1 is not None and x0 - last_x1 > 8.0:
                            cells_out.append(" ".join(t_ for t_ in cur).strip())
                            cur = []
                        cur.append(w[4])
                        last_x1 = x1
                    if cur:
                        cells_out.append(" ".join(t_ for t_ in cur).strip())
                    # pad/trim to n_cols
                    while len(cells_out) < n_cols: cells_out.append("")
                    grid_rows.append(cells_out[:n_cols])
                cells = grid_rows[:n_rows] if len(grid_rows) >= n_rows else grid_rows
                while len(cells) < n_rows:
                    cells.append([""] * n_cols)
            tables.append({
                "bbox": bb,
                "num_rows": len(cells),
                "num_cols": n_cols,
                "cells": cells,
            })
        except Exception:
            continue
    return tables


def page_info(doc, page_num_1based):
    page = doc[page_num_1based - 1]
    d = page.get_text("dict", sort=True) or {}
    flat_spans = []
    lines = []
    tables = get_tables(page)
    table_bboxes = [t["bbox"] for t in tables if t.get("bbox")]

    def span_in_table(s):
        for tb in table_bboxes:
            sb = s["bbox"]
            if sb[0] < tb[2] and sb[2] > tb[0] and sb[1] < tb[3] and sb[3] > tb[1]:
                return True
        return False

    for bi, block in enumerate(d.get("blocks", [])):
        if block.get("type") != 0:  # skip image/drawing blocks
            continue
        for line in block.get("lines", []):
            line_bb = line.get("bbox") or [0, 0, 0, 0]
            spans = []
            for span in line.get("spans", []):
                text = span.get("text", "")
                if not text.strip():
                    continue
                if span_in_table(span):
                    # skip spans inside tables to avoid duplicating into text
                    continue
                spans.append({
                    "text": text,
                    "fontSize": float(span.get("size") or 0),
                    "bold": bool(int(span.get("flags") or 0) & 16),
                    "italic": bool(int(span.get("flags") or 0) & 2),
                    "color": int(span.get("color") or 0),
                    "bbox": list(span.get("bbox")),
                })
            if spans:
                lines.append({
                    "text": "".join(s["text"] for s in spans),
                    "spans": spans,
                    "bbox": list(line_bb),
                })
                flat_spans.extend(spans)

    images = []
    try:
        for img in page.get_images(full=True):
            xref = img[0]
            try:
                rects = page.get_image_rects(xref)
                for r in rects:
                    images.append({"bbox": [r.x0, r.y0, r.x1, r.y1], "xref": xref})
            except Exception:
                pass
    except Exception:
        pass

    drawings = []
    try:
        for d in page.get_drawings():
            r = d.get("rect")
            if r:
                drawings.append({"bbox": [r.x0, r.y0, r.x1, r.y1]})
    except Exception:
        pass

    text_chars = sum(len(s["text"]) for s in flat_spans)
    try:
        total_text = page.get_text("text") or ""
        total_text_chars = len(total_text)
    except Exception:
        total_text_chars = text_chars

    return {
        "page": page_num_1based,
        "width": page.rect.width,
        "height": page.rect.height,
        "text_chars": text_chars,
        "text_chars_total": total_text_chars,
        "image_cover_frac": 0.0,  # filled below by caller
        "lines": lines,
        "spans": flat_spans,
        "tables": tables,
        "images": images,
        "drawings": drawings,
    }


def page_image_cover(doc, page_num_1based):
    page = doc[page_num_1based - 1]
    total = max(1.0, page.rect.width * page.rect.height)
    area = 0.0
    try:
        for img in page.get_images(full=True):
            try:
                rects = page.get_image_rects(img[0])
                for r in rects:
                    area += (r.x1 - r.x0) * (r.y1 - r.y0)
            except Exception:
                pass
    except Exception:
        pass
    return round(area / total, 4)


def cmd_analyze(pdf_path):
    doc = load_doc(pdf_path)
    pages = []
    for i in range(doc.page_count):
        info = page_info(doc, i + 1)
        info["image_cover_frac"] = page_image_cover(doc, i + 1)
        pages.append(info)
    doc.close()
    out = {"num_pages": len(pages), "pages": pages, "max_pages": MAX_PAGES}
    sys.stdout.write(json.dumps(out))


def cmd_crop(pdf_path, page_num, x0, y0, x1, y1, dpi, out_path):
    doc = load_doc(pdf_path)
    page = doc[page_num - 1]
    rect = pymupdf.Rect(x0, y0, x1, y1)
    pix = page.get_pixmap(dpi=dpi, clip=rect)
    pix.save(out_path)


def cmd_render(pdf_path, page_num, dpi, out_path):
    doc = load_doc(pdf_path)
    page = doc[page_num - 1]
    pix = page.get_pixmap(dpi=dpi)
    pix.save(out_path)


def cmd_image_to_pdf(image_path, out_path):
    """Wrap a single image file in a 1-page PDF."""
    doc = pymupdf.open()
    img = doc.new_page(width=1000)
    page = doc[0]
    rect = pymupdf.Rect(0, 0, page.rect.width, page.rect.height)
    page.insert_image(rect, filename=image_path)
    doc.save(out_path)


def cmd_images_to_pdf(image_paths, out_path):
    """Wrap several image files into a multi-page PDF, one image per page."""
    doc = pymupdf.open()
    for img_path in image_paths:
        page = doc.new_page()
        page.insert_image(page.rect, filename=img_path)
    doc.save(out_path)


def cmd_hide_empty_slides(src_path, dst_path):
    """Mark empty slides (no shapes) as hidden (show="0") in a COPY of the deck.

    LibreOffice skips hidden slides when exporting to PDF, so empty slides are
    never rendered — and never cost a VLM call. The original file is never
    touched: the caller converts a copy, not the upload.
    """
    import re
    import zipfile

    slide_re = re.compile(r"^ppt/slides/slide\d+\.xml$", re.IGNORECASE)
    shape_re = re.compile(r"<p:(sp|pic|graphicFrame|grpSp|cxnSp|contentPart)\b")
    hidden_re = re.compile(r"<p:sld\b[^>]*\bshow\s*=\s*[\"']0[\"']", re.IGNORECASE)

    with zipfile.ZipFile(src_path, "r") as zin:
        entries = [(info, zin.read(info.filename)) for info in zin.infolist()]

    hidden_count = 0
    with zipfile.ZipFile(dst_path, "w", zipfile.ZIP_DEFLATED) as zout:
        for info, data in entries:
            if slide_re.match(info.filename):
                text = data.decode("utf-8", errors="ignore")
                if not hidden_re.search(text) and not shape_re.search(text):
                    text = re.sub(r"<p:sld\b", '<p:sld show="0" ', text, count=1)
                    data = text.encode("utf-8")
                    hidden_count += 1
            zout.writestr(info, data)

    print(json.dumps({"ok": True, "hidden": hidden_count}))


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)

    pa = sub.add_parser("analyze")
    pa.add_argument("pdf")

    pc = sub.add_parser("crop")
    pc.add_argument("pdf")
    pc.add_argument("page", type=int)
    pc.add_argument("x0", type=float)
    pc.add_argument("y0", type=float)
    pc.add_argument("x1", type=float)
    pc.add_argument("y1", type=float)
    pc.add_argument("dpi", type=int)
    pc.add_argument("out_path")

    pr = sub.add_parser("render")
    pr.add_argument("pdf")
    pr.add_argument("page", type=int)
    pr.add_argument("dpi", type=int)
    pr.add_argument("out_path")

    pi = sub.add_parser("image-to-pdf")
    pi.add_argument("image")
    pi.add_argument("out_path")

    pm = sub.add_parser("images-to-pdf")
    pm.add_argument("out_path")
    pm.add_argument("images", nargs="+")

    ph = sub.add_parser("hide-empty-slides")
    ph.add_argument("src_pptx")
    ph.add_argument("dst_pptx")

    ns = p.parse_args()

    if ns.cmd == "analyze":
        cmd_analyze(ns.pdf)
    elif ns.cmd == "crop":
        cmd_crop(ns.pdf, ns.page, ns.x0, ns.y0, ns.x1, ns.y1, ns.dpi, ns.out_path)
    elif ns.cmd == "render":
        cmd_render(ns.pdf, ns.page, ns.dpi, ns.out_path)
    elif ns.cmd == "image-to-pdf":
        cmd_image_to_pdf(ns.image, ns.out_path)
    elif ns.cmd == "images-to-pdf":
        cmd_images_to_pdf(ns.images, ns.out_path)
    elif ns.cmd == "hide-empty-slides":
        cmd_hide_empty_slides(ns.src_pptx, ns.dst_pptx)


if __name__ == "__main__":
    main()
