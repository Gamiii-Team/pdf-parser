// src/figureAnalyzer/florence.js
// Florence implementation of the figure-analyzer interface.
// The whole-PDF Florence endpoint already returns a detailed caption per
// detection; this implementation simply maps that into the element shape.
// Structured chart/diagram data is NOT available from Florence — never
// invented: data stays null and the figure is flagged for review.

const LABEL_TO_TYPE = {
  "pie chart": "pie_chart",
  "bar chart": "bar_chart",
  "line chart": "line_chart",
  "scatter plot": "scatter",
  "flowchart": "flowchart",
  "graph": "line_chart",
};

export function createFlorenceAnalyzer() {
  return {
    name: "florence",
    /**
     * @param {{label: string, caption: string, bbox: number[]}} detection
     * @returns {{figure_type: string, description: string, data: null, needs_review: boolean}}
     */
    analyze({ label, caption }) {
      const figureType = LABEL_TO_TYPE[String(label ?? "").trim().toLowerCase()] ?? "other";
      const needsReview = !String(caption ?? "").trim();
      return {
        figure_type: figureType,
        description: String(caption ?? "").trim(),
        data: null,
        needs_review: needsReview,
      };
    },
  };
}
