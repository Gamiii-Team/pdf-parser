#!/usr/bin/env python3
"""pptx_hints.py deck.pptx -> JSON list (one entry per slide, original order) on stdout.

Runs INSIDE the isolated hints container against an untrusted deck that already
passed the plan's zip-level validation. Never throws: a per-slide failure yields an
{"error": ...} placeholder so slide indexes stay aligned.

Hidden/empty slides and positional page alignment are unchanged. Each hint entry
now also carries normalized 0-1 bounding boxes for pictures, charts, tables and
groups (the whole group — the diagram case — not its children, whose coordinates
live in the group's child space).
"""
import json
import sys

try:
    from pptx import Presentation
    from pptx.enum.shapes import MSO_SHAPE_TYPE as T
    _PPTX_OK = True
except Exception:
    Presentation = None
    T = None
    _PPTX_OK = False


def shape_text(s):
    try:
        if not getattr(s, "has_text_frame", False) or not s.text_frame.text.strip():
            return []
        out = []
        for p in s.text_frame.paragraphs:
            runs = "".join(r.text for r in p.runs)
            if runs.strip():
                out.append({"level": int(getattr(p, "level", 0)), "text": runs})
        return out
    except Exception:
        return []


def alt_text(shape):
    try:
        from pptx.oxml.ns import qn
        for node in shape._element.iter(qn("p:cNvPr")):
            descr = node.get("descr")
            if descr and descr.strip():
                return descr.strip()
        return None
    except Exception:
        return None


def norm_bbox(shape, slide_w, slide_h):
    """[x0, y0, x1, y1] normalized 0-1 (EMU ints from python-pptx — no unit conversion)."""
    try:
        x0 = float(shape.left) / slide_w
        y0 = float(shape.top) / slide_h
        x1 = float(shape.left + shape.width) / slide_w
        y1 = float(shape.top + shape.height) / slide_h
        if x1 <= x0 or y1 <= y0:
            return None
        return [round(max(0.0, min(1.0, v)), 6) for v in (x0, y0, x1, y1)]
    except Exception:
        return None


def chart_hint(ch, box):
    out = {"chart_type": str(getattr(ch, "chart_type", "unknown")), "title": None,
           "categories": [], "series": [], "bbox": box}
    try:
        if getattr(ch, "has_title", False):
            out["title"] = ch.chart_title.text_frame.text
        plot = ch.plots[0]
        try:
            out["categories"] = [str(c) for c in plot.categories]
        except Exception:
            pass
        try:
            out["series"] = [{"name": sr.name, "values": list(sr.values)} for sr in plot.series]
        except Exception:
            pass
    except Exception as e:
        out["error"] = str(e)
    return out


def slide_hint(idx, slide, slide_w, slide_h):
    h = {"slide": idx, "hidden": slide._element.get("show") == "0", "title": None,
         "text": [], "tables": [], "charts": [], "pictures": [], "groups": [], "notes": None}
    try:
        if slide.shapes.title is not None:
            h["title"] = slide.shapes.title.text
    except Exception:
        pass

    def visit(shapes, top_level):
        for s in shapes:
            try:
                if s.shape_type == T.GROUP:
                    if top_level:
                        h["groups"].append({"alt": alt_text(s), "bbox": norm_bbox(s, slide_w, slide_h)})
                    visit(s.shapes, False)
                    continue
                h["text"].append(shape_text(s))
                box = norm_bbox(s, slide_w, slide_h) if top_level else None
                if top_level and getattr(s, "has_table", False) and s.has_table:
                    try:
                        h["tables"].append({"rows": [[c.text for c in row.cells] for row in s.table.rows], "bbox": box})
                    except Exception:
                        pass
                if top_level and getattr(s, "has_chart", False) and s.has_chart:
                    try:
                        h["charts"].append(chart_hint(s.chart, box))
                    except Exception:
                        pass
                if top_level and getattr(s, "shape_type", None) == T.PICTURE:
                    h["pictures"].append({"alt": alt_text(s), "bbox": box})
            except Exception:
                continue

    visit(slide.shapes, True)

    try:
        if slide.has_notes_slide:
            h["notes"] = slide.notes_slide.notes_text_frame.text or None
    except Exception:
        pass
    flat_text = []
    for entry in h["text"]:
        flat_text.extend(entry)
    h["text"] = flat_text
    h["empty"] = not (h["text"] or h["tables"] or h["charts"] or h["pictures"])
    return h


def main():
    if not _PPTX_OK:
        print(json.dumps({"error": "python-pptx not available in container"}), file=sys.stderr)
        return 1
    try:
        prs = Presentation(sys.argv[1])
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        return 1
    slide_w = float(prs.slide_width)
    slide_h = float(prs.slide_height)
    out = []
    for i, slide in enumerate(prs.slides):
        try:
            out.append(slide_hint(i + 1, slide, slide_w, slide_h))
        except Exception as e:
            out.append({"slide": i + 1, "error": str(e)})
    json.dump(out, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
