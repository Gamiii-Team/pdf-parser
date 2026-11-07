// index.js
import path from "path";
import { fileURLToPath } from "url";
import { extractTextFromPdf, extractTablesFromPdf } from "./src/extractor.js"; // Note the .js extension
import { detectVisualPages } from "./src/visual/pageDetector.js";

// ES Module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  console.log("🚀 Starting PDF Extraction...\n");

  // Point to the test.pdf in the root of this project
  const pdfPath = path.join(__dirname, "test.pdf");

  try {
    // ==========================================
    // 1. Extract and Print FULL Plain Text
    // ==========================================
    console.log("📄 Step 1: Extracting plain text...");
    const extractedText = await extractTextFromPdf(pdfPath);

    console.log("✅ Plain text extracted successfully.");
    console.log("📊 Total Characters:", extractedText.length);

    console.log("\n📝 FULL DOCUMENT CONTENTS:");
    console.log("=".repeat(60));
    // This prints the entire extracted text of the document
    console.log(extractedText);
    console.log("=".repeat(60) + "\n");

    // ==========================================
    // 2. Extract and Print ALL Table Rows
    // ==========================================
    console.log("📊 Step 2: Extracting structured table data...");
    const tables = await extractTablesFromPdf(pdfPath);

    // Dynamically calculate the total row count based on the array length
    const totalRows = tables.length;
    console.log(`✅ Found a total of ${totalRows} rows of tabular data.\n`);

    if (totalRows > 0) {
      console.log("📝 FULL TABLE DATA (All Rows):");
      console.log("-".repeat(60));

      // Iterate through EVERY single row dynamically (no hardcoded limits)
      tables.forEach((row, index) => {
        console.log(row.join(" | "));
      });

      console.log("-".repeat(60) + "\n");
    } else {
      console.log("ℹ️  No tabular data (rows) were detected in this PDF.\n");
    }

    // ==========================================
    // 3. Identify Pages Containing Visual Content
    // ==========================================
    console.log("🖼️ Step 3: Detecting visual content...");

    const visualAnalysis = await detectVisualPages(pdfPath);

    console.log(`✅ Analyzed ${visualAnalysis.totalPages} PDF pages.`);

    console.log(
      `🔍 Potential visual pages: ${visualAnalysis.candidateCount}\n`,
    );

    console.log("📊 PAGE ANALYSIS:");
    console.log("=".repeat(90));

    console.table(
      visualAnalysis.pages.map((page) => ({
        Page: page.pageNumber,
        Images: page.imageCount,
        Table: page.tableMetrics.rowCount,
        ImageCoverage: page.imageCoverage,
        TextLength: page.visibleTextLength,
        Candidate: page.isCandidate ? "YES" : "NO",
        Reasons: page.reasons.join(", "),
      })),
    );

    console.log("=".repeat(130));

    // if (visualAnalysis.candidateCount > 0) {
    //   console.log("\n🖼️ CANDIDATE VISUAL CONTENT:");

    //   for (const page of visualAnalysis.candidates) {
    //     console.log(`\nPage ${page.pageNumber}`);
    //     console.log("Reasons:", page.reasons.join(", "));
    //     console.log("Text preview:", page.textPreview);
    //   }
    // }
  } catch (error) {
    console.error("❌ Error:", error.message);
    console.log(
      '\n💡 Tip: Make sure you have a file named "test.pdf" in the project root.',
    );
  }
}

main();
