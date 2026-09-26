import fsp from 'node:fs/promises';
import { blobPath } from './paths.js';

// Removes a file node's blob(s) from disk - the current one plus every
// retained old version. Safe to call on a folder (no-op) or on a node
// whose blob is already gone.
export async function purgeNodeBlob(node) {
  if (node.type !== 'file') return;
  const blobNames = [node.blobName, node.thumbnailBlobName, ...(node.versions || []).map((v) => v.blobName)].filter(
    Boolean
  );
  await Promise.all(blobNames.map((name) => fsp.unlink(blobPath(name)).catch(() => {})));
}
