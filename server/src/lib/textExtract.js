import fsp from 'node:fs/promises';
import { PDFParse } from 'pdf-parse';

// Caps keep metadata.json (the whole app's single-file store) from bloating
// on large uploads - search only needs enough text to find a match, not a
// byte-perfect copy of the file.
const MAX_STORED_CHARS = 200_000;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_READ_BYTES = 5 * 1024 * 1024;

const TEXT_EXT_RE = /\.(txt|md|markdown|json|csv|log|js|jsx|ts|tsx|py|java|go|rs|c|cpp|h|css|html|yml|yaml|sh|xml)$/i;

// Best-effort text extraction for full-text search - returns null (rather
// than throwing) for anything unsupported or unreadable, so a bad/corrupt
// upload never blocks the upload itself.
export async function extractText(filePath, { mimeType, name, size }) {
  try {
    if (mimeType === 'application/pdf' || /\.pdf$/i.test(name)) {
      if (!size || size > MAX_PDF_BYTES) return null;
      const buf = await fsp.readFile(filePath);
      const parser = new PDFParse({ data: buf });
      try {
        const result = await parser.getText();
        return (result.text || '').slice(0, MAX_STORED_CHARS) || null;
      } finally {
        await parser.destroy();
      }
    }

    const isText = (mimeType && mimeType.startsWith('text/')) || TEXT_EXT_RE.test(name);
    if (!isText) return null;

    if (size > MAX_TEXT_READ_BYTES) {
      const fh = await fsp.open(filePath, 'r');
      try {
        const buf = Buffer.alloc(MAX_TEXT_READ_BYTES);
        await fh.read(buf, 0, MAX_TEXT_READ_BYTES, 0);
        return buf.toString('utf-8').slice(0, MAX_STORED_CHARS) || null;
      } finally {
        await fh.close();
      }
    }

    const content = await fsp.readFile(filePath, 'utf-8');
    return content.slice(0, MAX_STORED_CHARS) || null;
  } catch {
    return null;
  }
}
