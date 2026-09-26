import fsp from 'node:fs/promises';
import sharp from 'sharp';

const MAX_DIMENSION = 4000;
const JPEG_QUALITY = 85;
const PNG_COMPRESSION_LEVEL = 9;
const WEBP_QUALITY = 85;
const MIN_BYTES_TO_COMPRESS = 2 * 1024 * 1024; // skip already-small images
const COMPRESSIBLE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

// Re-encodes/downsizes a large image in place, an opt-in trade of some
// quality for less disk space - keeps the original format (so a .png stays
// a real PNG, just smaller) rather than converting everything to JPEG.
// Returns the new byte size, or null if nothing was changed (too small
// already, an unsupported format, or the "compressed" result wasn't
// actually smaller) - the original file is left untouched either way.
export async function compressImageInPlace(filePath, { mimeType, size }) {
  if (!COMPRESSIBLE_TYPES.has(mimeType) || size < MIN_BYTES_TO_COMPRESS) return null;

  try {
    const metadata = await sharp(filePath).metadata();
    let pipeline = sharp(filePath).rotate();
    if ((metadata.width || 0) > MAX_DIMENSION || (metadata.height || 0) > MAX_DIMENSION) {
      pipeline = pipeline.resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true });
    }
    if (mimeType === 'image/jpeg') pipeline = pipeline.jpeg({ quality: JPEG_QUALITY, mozjpeg: true });
    else if (mimeType === 'image/png') pipeline = pipeline.png({ compressionLevel: PNG_COMPRESSION_LEVEL });
    else pipeline = pipeline.webp({ quality: WEBP_QUALITY });

    const buf = await pipeline.toBuffer();
    if (buf.length >= size) return null;
    await fsp.writeFile(filePath, buf);
    return buf.length;
  } catch {
    return null;
  }
}
