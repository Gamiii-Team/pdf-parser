#!/usr/bin/env python3
"""scripts/make-chart-png.py <out.png> — render a readable bar chart fixture image.

Drawn with PyMuPDF (vector text/shapes rasterized once) so the fixture chart
carries a title, axis gridlines, axis numbers, axis category labels and bars
proportional to values 10/12/15/14. A VLM can transcribe it with estimates:true.
Requires PyMuPDF (see requirements.txt; npm run setup builds the venv).
"""
import sys
import pymupdf

W, H = 480, 300
BARS = [10, 12, 15, 14]
MONTHS = ["January", "February", "March", "April"]
TICKS = [0, 5, 10, 15]
PLOT_TOP, PLOT_BOTTOM, PLOT_LEFT, PLOT_RIGHT = 34, 262, 44, 470
SPAN = PLOT_BOTTOM - PLOT_TOP


def y_of(v):
    return PLOT_BOTTOM - (v / 15.0) * SPAN


def main():
    out = sys.argv[1]
    doc = pymupdf.open()
    page = doc.new_page(width=W, height=H)  # white background by default

    page.insert_text(pymupdf.Point(116, 22), "Revenue by Month", fontsize=15, color=(0.1, 0.1, 0.1))

    # axis lines
    page.draw_line(pymupdf.Point(PLOT_LEFT, PLOT_BOTTOM), pymupdf.Point(PLOT_RIGHT, PLOT_BOTTOM), width=1.6, color=(0.25, 0.25, 0.25))
    page.draw_line(pymupdf.Point(PLOT_LEFT, PLOT_BOTTOM), pymupdf.Point(PLOT_LEFT, PLOT_TOP), width=1.6, color=(0.25, 0.25, 0.25))

    # gridlines + y tick labels
    for v in TICKS:
        y = y_of(v)
        if v > 0:
            page.draw_line(pymupdf.Point(PLOT_LEFT, y), pymupdf.Point(PLOT_RIGHT, y), width=0.7, color=(0.82, 0.82, 0.82), dashes="[4 3] 0")
        page.insert_text(pymupdf.Point(16, y + 5), str(v), fontsize=13, color=(0.25, 0.25, 0.25))

    # bars
    bar_w = 66
    step = (PLOT_RIGHT - PLOT_LEFT - 20) / 4
    for i, v in enumerate(BARS):
        x0 = PLOT_LEFT + 14 + i * step
        x1 = x0 + bar_w
        rect = pymupdf.Rect(x0, y_of(v), x1, PLOT_BOTTOM)
        page.draw_rect(rect, color=(0.145, 0.388, 0.922), fill=(0.145, 0.388, 0.922), width=1)

    # x labels
    for i, m in enumerate(MONTHS):
        x0 = PLOT_LEFT + 14 + i * step
        page.insert_text(pymupdf.Point(x0 - 2, PLOT_BOTTOM + 18), m, fontsize=12.5, color=(0.25, 0.25, 0.25))

    pix = page.get_pixmap(dpi=170)
    pix.save(out)
    print(f"wrote {out} ({pix.width}x{pix.height})")


if __name__ == "__main__":
    main()
