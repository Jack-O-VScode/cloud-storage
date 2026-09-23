import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

// Files on disk are named by opaque blob id (uuid), never by the
// user-visible filename or folder path. This sidesteps path-traversal
// entirely and lets rename/move be pure metadata operations.
export function blobPath(blobName) {
  return path.join(config.blobDir, blobName);
}

export async function diskUsage() {
  try {
    const stats = await fs.statfs(config.dataDir);
    const total = stats.blocks * stats.bsize;
    const free = stats.bavail * stats.bsize;
    return { total, free, used: total - free };
  } catch {
    // statfs isn't available on every platform/Node build - degrade gracefully.
    return { total: null, free: null, used: null };
  }
}
