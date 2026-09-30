import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { blobPath } from './paths.js';
import { extractText } from './textExtract.js';
import { generateThumbnail } from './thumbnail.js';

export const MAX_VERSIONS = 10;

// Generates and writes a thumbnail blob for an image file, returning its
// blob name (or null for a non-image / an image sharp couldn't decode).
export async function maybeGenerateThumbnail(mimeType, sourcePath) {
  if (!mimeType || !mimeType.startsWith('image/')) return null;
  const thumbBuf = await generateThumbnail(sourcePath);
  if (!thumbBuf) return null;
  const thumbName = crypto.randomUUID();
  await fsp.writeFile(blobPath(thumbName), thumbBuf);
  return thumbName;
}

// Swaps a file node's content for a new blob, keeping the previous
// content as a version (so an overwrite is always recoverable) and
// refreshing the derived search text/thumbnail. `keepVersion: false` is
// for replacing an empty placeholder, which isn't worth a history slot.
export async function replaceFileContent(node, { blobName, size, mimeType }, { keepVersion = true } = {}) {
  if (keepVersion && node.blobName) {
    node.versions ||= [];
    node.versions.push({
      id: crypto.randomUUID(),
      blobName: node.blobName,
      size: node.size,
      mimeType: node.mimeType,
      createdAt: node.updatedAt || node.createdAt,
    });
    while (node.versions.length > MAX_VERSIONS) {
      const dropped = node.versions.shift();
      await fsp.unlink(blobPath(dropped.blobName)).catch(() => {});
    }
  } else if (node.blobName) {
    await fsp.unlink(blobPath(node.blobName)).catch(() => {});
  }

  const oldThumbnailBlobName = node.thumbnailBlobName;
  node.blobName = blobName;
  node.size = size;
  node.mimeType = mimeType;
  node.updatedAt = Date.now();
  const contentText = await extractText(blobPath(blobName), { mimeType, name: node.name, size });
  if (contentText) node.contentText = contentText;
  else delete node.contentText;
  const thumbnailBlobName = await maybeGenerateThumbnail(mimeType, blobPath(blobName));
  if (thumbnailBlobName) node.thumbnailBlobName = thumbnailBlobName;
  else delete node.thumbnailBlobName;
  if (oldThumbnailBlobName) await fsp.unlink(blobPath(oldThumbnailBlobName)).catch(() => {});
}
