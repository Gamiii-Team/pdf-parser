// index.js
import path from "path";
import { fileURLToPath } from "url";
import { extractTextFromPdf, extractTablesFromPdf } from "./src/extractor.js"; // Note the .js extension

// ES Module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  console.log("🚀 Starting PDF Extraction...\n");

  // Point to the test.pdf in the root of this project
  const pdfPath = path.join(__dirname, "test.pdf");

  try {
    // 1. Extract Plain Text
    console.log("📄 Step 1: Extracting plain text...");
    const extractedText = await extractTextFromPdf(pdfPath);
    console.log(
      "✅ Plain text extracted. Length:",
      extractedText.length,
      "chars\n",
    );

    // 2. Extract Structured Tables
    console.log("📊 Step 2: Extracting structured table data...");
    const tables = await extractTablesFromPdf(pdfPath);

    console.log(`✅ Found ${tables.length} potential rows of tabular data.\n`);

    // Display the first 5 rows of the extracted table as an example
    console.log("📝 Table Preview (First 5 rows):");
    console.log("--------------------------------------------------");
    tables.slice(0, 50_000_000_000).forEach((row, index) => {
      console.log(`Row ${index + 1}:`, row.join(" | "));
    });
    console.log("--------------------------------------------------\n");
  } catch (error) {
    console.error("❌ Error:", error.message);
    console.log(
      '\n💡 Tip: Make sure you have a file named "test.pdf" in the project root.',
    );
  }
}

main();
