// src/extractor.js
import fs from "fs";
import { extractText, extractTextItems } from "unpdf";

/**
 * Extracts text from a PDF file given its file path.
 * @param {string} filePath - The path to the PDF file.
 * @returns {Promise<string>} - The extracted text.
 */
export async function extractTextFromPdf(filePath) {
  try {
    // 1. Read the file into a Node.js Buffer
    const dataBuffer = fs.readFileSync(filePath);

    // unpdf requires a Uint8Array
    const uint8Array = new Uint8Array(dataBuffer);

    const result = await extractText(uint8Array, { mergePages: false });
    console.log("result: " + result);

    // 3. Clean up excessive whitespace
    // const cleanText = result.text.replace(/\s+/g, " ").trim();

    const cleanText = (
      Array.isArray(result.text)
        ? result.text.join(" ")
        : typeof result.text === "string"
          ? result.text
          : ""
    )
      .replace(/\s+/g, " ")
      .trim();

    return cleanText;
  } catch (error) {
    console.error("PDF Text Extraction Error:", error.message);
    throw new Error("Failed to extract text from PDF");
  }
}

/**
 * Extracts structured table data from a PDF file using X/Y coordinates.
 */
export async function extractTablesFromPdf(filePath) {
  try {
    const dataBuffer = fs.readFileSync(filePath);
    const uint8Array = new Uint8Array(dataBuffer);

    // Get every text item with X/Y corrdinates
    const { items } = await extractTextItems(uint8Array);

    // 2. Flatten the 2D array (pages -> items) into a single 1D array
    const allItems = items.flat();

    const tables = [];
    let currentTable = [];
    let lastY = null;
    const Y_TOLERANCE = 5; // Pixels of tolerance to consider items on the same row

    // 1. Group items by Y coordinate (Rows)
    for (const item of allItems) {
      // Skip empty items
      if (!item || typeof item.str !== "string" || !item.str.trim()) continue;

      if (lastY === null || Math.abs(item.y - lastY) > Y_TOLERANCE) {
        // New row detected
        if (currentTable.length > 0) {
          // Sort the previous row by X coordinate (Columns) before saving
          currentTable.sort((a, b) => a.x - b.x);
          tables.push(currentTable);
        }
        currentTable = [item];
        lastY = item.y;
      } else {
        // Same row, add to current group
        currentTable.push(item);
      }
    }
    // Push the final row
    if (currentTable.length > 0) {
      currentTable.sort((a, b) => a.x - b.x);
      tables.push(currentTable);
    }

    // 2. Format into a clean 2D array of strings (Rows -> Columns)
    const structuredTables = tables.map((row) =>
      row.map((item) =>
        item && typeof item.str === "string" ? item.str.trim() : "",
      ),
    );

    return structuredTables;
  } catch (error) {
    console.error("PDF Table Extraction Error:", error.message);
    throw new Error("Failed to extract tables from PDF");
  }
}
