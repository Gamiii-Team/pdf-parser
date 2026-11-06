// index.js
import path from "path";
import { fileURLToPath } from "url";
import { extractTextFromPdf } from "./src/extractor.js"; // Note the .js extension

// ES Module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  console.log("🚀 Starting PDF Extraction...\n");

  // Point to the test.pdf in the root of this project
  const pdfPath = path.join(__dirname, "test.pdf");

  try {
    console.log("📄 Extracting text from test.pdf...");
    const extractedText = await extractTextFromPdf(pdfPath);

    console.log("\n✅ Extraction Successful!\n");
    console.log("📊 Total Characters:", extractedText.length);
    console.log("\n📝 Text Preview");
    console.log("--------------------------------------------------");
    console.log(extractedText);
    console.log("--------------------------------------------------\n");
  } catch (error) {
    console.error("❌ Error:", error.message);
    console.log(
      '\n💡 Tip: Make sure you have a file named "test.pdf" in the project root.',
    );
  }
}

main();
