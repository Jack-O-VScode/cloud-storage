import fsp from 'node:fs/promises';
import { blobPath } from './paths.js';

// Removes a file node's blob from disk. Safe to call on a folder (no-op)
// or on a node whose blob is already gone.
export async function purgeNodeBlob(node) {
  if (node.type === 'file' && node.blobName) {
    await fsp.unlink(blobPath(node.blobName)).catch(() => {});
  }
}
