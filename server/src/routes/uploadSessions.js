import { Router } from 'express';
import express from 'express';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import mime from 'mime-types';
import { config } from '../config.js';
import { getState, save, findNodeById, findUserById, allOwnedBy, logActivity } from '../store.js';
import { requireAuth, requireFetchHeader } from '../auth.js';
import { blobPath } from '../lib/paths.js';
import { extractText } from '../lib/textExtract.js';
import { compressImageInPlace } from '../lib/imageCompress.js';
import { createSession, getSession, deleteSession } from '../lib/uploadSessions.js';
import {
  maybeGenerateThumbnail,
  assertParentIsUsableFolder,
  resolveFolderChain,
  sanitizeName,
  serialize,
  fromClientParentId,
} from './nodes.js';

const router = Router();

// A resumable upload is one file per session: the client chunks the file
// and PUTs pieces sequentially, retrying from wherever the server says it
// actually got to if a chunk's response is lost to a network drop -
// instead of the whole file having to restart from byte zero.
router.post('/', requireFetchHeader, requireAuth, async (req, res) => {
  const { name: rawName, size, mimeType: clientMimeType, parentId: clientParentId, relativePath } = req.body || {};
  const parentId = fromClientParentId(clientParentId);
  if (!assertParentIsUsableFolder(req, res, parentId, 'upload')) return;
  if (!Number.isFinite(size) || size <= 0 || size > config.maxUploadBytes) {
    return res.status(400).json({ error: 'Invalid or missing file size' });
  }

  const parent = parentId ? findNodeById(parentId) : null;
  const ownerId = parent ? parent.ownerId : req.user.id;
  const owner = findUserById(ownerId);

  if (owner?.quotaBytes) {
    const currentlyUsed = allOwnedBy(ownerId)
      .filter((n) => n.type === 'file' && !n.trashed)
      .reduce((sum, n) => sum + (n.size || 0), 0);
    if (currentlyUsed + size > owner.quotaBytes) {
      return res.status(413).json({
        error: `This upload would exceed the storage quota (${(owner.quotaBytes / 1e9).toFixed(1)}GB). Free up space or ask an admin to raise the quota.`,
      });
    }
  }

  const name = sanitizeName(rawName);
  const mimeType = clientMimeType || mime.lookup(name) || 'application/octet-stream';
  const tempBlobName = crypto.randomUUID();
  await fsp.writeFile(blobPath(tempBlobName), Buffer.alloc(0));

  const session = createSession({
    uploaderId: req.user.id,
    ownerId,
    parentId,
    relativePath: typeof relativePath === 'string' ? relativePath : '',
    name,
    mimeType,
    size,
    tempBlobName,
  });

  res.status(201).json({ sessionId: session.id });
});

// Chunks are raw bytes, not JSON - parsed only on this route, keyed by the
// client sending Content-Type: application/octet-stream (the app-wide
// express.json() middleware ignores non-JSON content types, so the two
// coexist without conflict).
const rawBody = express.raw({ type: '*/*', limit: '20mb' });

router.put('/:id/chunk', requireFetchHeader, requireAuth, rawBody, async (req, res) => {
  const session = getSession(req.params.id);
  if (!session || session.uploaderId !== req.user.id) {
    return res.status(404).json({ error: 'Upload session not found or expired' });
  }
  const offset = parseInt(req.headers['x-chunk-offset'], 10);
  if (!Number.isFinite(offset) || offset < 0) {
    return res.status(400).json({ error: 'Missing or invalid X-Chunk-Offset header' });
  }
  const chunk = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

  // A chunk at an offset already received means the client's own response
  // to that write was lost (e.g. the connection dropped right after the
  // server wrote it) - confirm the current state rather than re-appending
  // and corrupting the file with duplicate bytes.
  if (offset < session.receivedBytes) {
    return res.json({ receivedBytes: session.receivedBytes });
  }
  if (offset !== session.receivedBytes) {
    return res.status(409).json({ error: 'Offset mismatch', receivedBytes: session.receivedBytes });
  }
  if (session.receivedBytes + chunk.length > session.size) {
    return res.status(400).json({ error: 'Chunk exceeds the declared file size' });
  }

  await fsp.appendFile(blobPath(session.tempBlobName), chunk);
  session.receivedBytes += chunk.length;
  res.json({ receivedBytes: session.receivedBytes });
});

router.post('/:id/complete', requireFetchHeader, requireAuth, async (req, res) => {
  const session = getSession(req.params.id);
  if (!session || session.uploaderId !== req.user.id) {
    return res.status(404).json({ error: 'Upload session not found or expired' });
  }
  if (session.receivedBytes !== session.size) {
    return res.status(400).json({ error: 'Upload incomplete', receivedBytes: session.receivedBytes, size: session.size });
  }

  let targetParentId = session.parentId;
  if (session.relativePath) {
    const segments = session.relativePath.split('/').filter(Boolean);
    segments.pop(); // last segment is the filename itself, not a folder
    if (segments.length) {
      targetParentId = resolveFolderChain(session.ownerId, session.parentId, segments, new Map());
    }
  }

  let fileSize = session.size;
  const owner = findUserById(session.ownerId);
  if (owner?.preferences?.compressImages) {
    const compressedSize = await compressImageInPlace(blobPath(session.tempBlobName), {
      mimeType: session.mimeType,
      size: fileSize,
    });
    if (compressedSize) fileSize = compressedSize;
  }

  const now = Date.now();
  const node = {
    id: crypto.randomUUID(),
    name: session.name,
    type: 'file',
    parentId: targetParentId,
    ownerId: session.ownerId,
    size: fileSize,
    mimeType: session.mimeType,
    blobName: session.tempBlobName,
    trashed: false,
    trashedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const contentText = await extractText(blobPath(session.tempBlobName), {
    mimeType: session.mimeType,
    name: session.name,
    size: fileSize,
  });
  if (contentText) node.contentText = contentText;
  const thumbnailBlobName = await maybeGenerateThumbnail(session.mimeType, blobPath(session.tempBlobName));
  if (thumbnailBlobName) node.thumbnailBlobName = thumbnailBlobName;

  getState().nodes.push(node);
  logActivity({ userId: req.user.id, username: req.user.username, action: 'upload', targetName: node.name });
  await save();
  deleteSession(session.id);
  res.status(201).json({ item: serialize(node) });
});

export default router;
