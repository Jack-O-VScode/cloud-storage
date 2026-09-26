import sharp from 'sharp';

const THUMB_MAX_DIMENSION = 320;

// Generates a small JPEG thumbnail for an image file - returns null (never
// throws) for anything sharp can't decode, so a corrupt/unsupported image
// just means no thumbnail; the thumbnail route then falls back to the
// original file.
export async function generateThumbnail(filePath) {
  try {
    return await sharp(filePath)
      .rotate() // auto-orients based on EXIF, so a phone photo doesn't thumbnail sideways
      .resize(THUMB_MAX_DIMENSION, THUMB_MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 72 })
      .toBuffer();
  } catch {
    return null;
  }
}
