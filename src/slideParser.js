import fs from 'fs';

/**
 * Extracts plain text from a PDF buffer (e.g. lecture slides).
 * Returns null if the PDF appears to be image-only (no extractable text).
 *
 * @param {Buffer} buffer
 * @returns {Promise<string|null>}
 */
export async function parsePdfBuffer(buffer) {
  // pdf-parse v2 exposes a PDFParse class (v1's default-export function no longer exists).
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: buffer });
  let raw;
  try {
    raw = (await parser.getText()).text ?? '';
  } finally {
    await parser.destroy();
  }

  const text = raw
    .replace(/^-- \d+ of \d+ --$/gm, '') // page separators added by pdf-parse
    .replace(/^[ \t]+/gm, '')            // strip leading whitespace from each line
    .replace(/\n{3,}/g, '\n\n')          // collapse runs of blank lines
    .trim();

  if (text.length < 50) {
    // Likely a scanned/image-only PDF — nothing useful to extract.
    return null;
  }

  return text;
}

/**
 * Extracts plain text from a PDF file on disk.
 *
 * @param {string} filePath
 * @returns {Promise<string|null>}
 */
export async function parsePdfFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  return parsePdfBuffer(buffer);
}
