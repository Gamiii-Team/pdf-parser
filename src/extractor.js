// src/extractor.js
import fs from "fs";
import { PDFParse } from "pdf-parse";

/**
 * Extracts text from a PDF file given its file path.
 * @param {string} filePath - The path to the PDF file.
 * @returns {Promise<string>} - The extracted text.
 */
export async function extractTextFromPdf(filePath) {
  let parser;
  try {
    // 1. Read the file into a Node.js Buffer
    const dataBuffer = fs.readFileSync(filePath);

    parser = new PDFParse({ data: dataBuffer });
    const result = await parser.getText();

    // 3. Clean up excessive whitespace
    const cleanText = result.text.replace(/\s+/g, " ").trim();

    return cleanText;
  } catch (error) {
    console.error("PDF Extraction Error:", error.message);
    throw new Error("Failed to extract text from PDF");
  } finally {
    if (parser) await parser.destroy();
  }
}
