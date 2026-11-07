import { readFile } from "node:fs/promises";
import { getDocumentProxy, extractTextItems, inspectPages } from "unpdf";

// These phrases suggest that a page might contain
// a figure, chart, diagram or table.
const VISUAL_CAPTION_PATTERN =
  /\b(?:figure|fig\.?|chart|graph|diagram|illustration|exhibit|table)\s*(?:no\.?\s*)?\d*/i;

/**
 * Finds PDF pages that potentially contain visual content.
 *
 * This is a candidate detector, not a definitive classifier.
 *
 * @param {string} filePath
 * @returns {Promise<object>}
 */
export async function detectVisualPages(filePath) {
  const fileBuffer = await readFile(filePath);

  // Prevent a single oversized image from allocating excessive memory.
  const pdf = await getDocumentProxy(new Uint8Array(fileBuffer), {
    maxImageSize: 16_777_216,
  });

  try {
    // Get positioned text, preserving page boundaries.
    const { items } = await extractTextItems(pdf);

    // Get image and text statistics for each page.
    const { pages: pageStats } = await inspectPages(pdf);

    const allPages = [];

    for (let index = 0; index < pdf.numPages; index++) {
      const pageNumber = index + 1;

      const pageItems = items[index] || [];
      const stats = pageStats[index] || {};

      const pageText = pageItems
        .map((item) => item.str || "")
        .join(" ")
        .trim();

      const reasons = [];

      const imageCount = stats.imageCount ?? 0;
      const imageCoverage = stats.imageCoverage ?? 0;

      const visibleTextLength = Math.max(
        0,
        (stats.textLength ?? 0) - (stats.invisibleTextLength ?? 0),
      );

      // 1. Embedded images.
      if (imageCount > 0) {
        reasons.push("embedded-image");
      }

      // 2. Significant image coverage.
      if (imageCoverage >= 0.05) {
        reasons.push("significant-image-coverage");
      }

      // 3. Figure/chart/table captions.
      if (VISUAL_CAPTION_PATTERN.test(pageText)) {
        reasons.push("visual-caption");
      }

      // 4. Pages that are likely scanned documents.
      if (visibleTextLength < 30 && imageCoverage >= 0.2) {
        reasons.push("possible-scanned-page");
      }

      // =====================================================================
      // 5. NEW: Detect native table structures based on X/Y alignment
      // =====================================================================
      const Y_TOLERANCE = 5; // Pixels of tolerance to consider items on the same row
      let lastY = null;
      let rowCount = 0;
      let multiColumnRowCount = 0;
      let currentRowItems = 0;

      for (const item of pageItems) {
        // Skip empty or invalid items
        if (!item || typeof item.str !== "string" || !item.str.trim()) continue;

        if (lastY === null || Math.abs(item.y - lastY) > Y_TOLERANCE) {
          // New row detected
          if (currentRowItems > 1) {
            multiColumnRowCount++; // This row has multiple columns
          }
          rowCount++;
          currentRowItems = 1;
          lastY = item.y;
        } else {
          // Same row, increment column count
          currentRowItems++;
        }
      }

      // Check the final row
      if (currentRowItems > 1) {
        multiColumnRowCount++;
      }

      // If a page has a significant grid-like structure, flag it as a table.
      // (e.g., at least 3 rows with multiple columns, and at least 4 total rows)
      if (multiColumnRowCount >= 3 && rowCount >= 4) {
        reasons.push("table-structure");
      }
      // =====================================================================

      allPages.push({
        pageNumber,
        imageCount,
        imageCoverage: Number(imageCoverage.toFixed(3)),
        visibleTextLength,
        isCandidate: reasons.length > 0,
        reasons,
        textPreview: pageText.slice(0, 250),
        tableMetrics: { rowCount, multiColumnRowCount },
      });
    }

    return {
      totalPages: pdf.numPages,
      candidateCount: allPages.filter((page) => page.isCandidate).length,
      candidates: allPages.filter((page) => page.isCandidate),
      pages: allPages,
    };
  } finally {
    if (typeof pdf.destroy === "function") {
      await pdf.destroy();
    } else if (typeof pdf.cleanup === "function") {
      await pdf.cleanup();
    }
  }
}
