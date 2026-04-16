import fs from 'fs';

/**
 * Extracts plain text from a PDF buffer (e.g. lecture slides).
 * Returns null if the PDF appears to be image-only (no extractable text).
 *
 * @param {Buffer} buffer
 * @returns {Promise<string|null>}
 */
export async function parsePdfBuffer(buffer) {
  const { default: pdfParse } = await import('pdf-parse');
  const data = await pdfParse(buffer);
  const text = (data.text ?? '').trim();

  if (text.length < 50) {
    // Likely a scanned/image-only PDF — nothing useful to extract.
    return null;
  }

  // Clean up the raw extraction:
  // pdf-parse often produces excessive blank lines and stray page markers.
  return text
    .replace(/\n{3,}/g, '\n\n')   // collapse runs of blank lines
    .replace(/^\s+/gm, '')        // strip leading whitespace from each line
    .trim();
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
