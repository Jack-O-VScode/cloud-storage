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
import { hasAccess } from '../lib/access.js';
import { maybeGenerateThumbnail, replaceFileContent } from '../lib/versions.js';
import { sanitizeName, findSibling, uniqueName } from '../lib/names.js';
import {
  createSession,
  getSession,
  deleteSession,
  withSessionLock,
  pendingBytesFor,
} from '../lib/uploadSessions.js';
import { assertParentIsUsableFolder, resolveFolderChain, serialize, fromClientParentId } from './nodes.js';

const router = Router();

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function sendError(res, err) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
  console.error(err);
  return res.status(500).json({ error: 'Upload failed on the server' });
}

function usedBytes(ownerId) {
  return allOwnedBy(ownerId)
    .filter((n) => n.type === 'file' && !n.trashed)
    .reduce((sum, n) => sum + (n.size || 0), 0);
}

// Throws if `incomingBytes` more would push `ownerId` past their quota,
// counting other uploads of theirs already under way.
export function assertQuota(ownerId, incomingBytes) {
  const owner = findUserById(ownerId);
  if (!owner?.quotaBytes || incomingBytes <= 0) return;
  if (usedBytes(ownerId) + pendingBytesFor(ownerId) + incomingBytes > owner.quotaBytes) {
    throw new HttpError(
      413,
      `This upload would exceed the storage quota (${(owner.quotaBytes / 1e9).toFixed(1)}GB). Free up space or ask an admin to raise the quota.`
    );
  }
}

function parseSize(raw) {
  const size = Number(raw);
  // Zero is a perfectly good size - empty placeholder files (.gitkeep,
  // __init__.py, ...) turn up in folder uploads all the time.
  if (!Number.isFinite(size) || size < 0 || !Number.isInteger(size)) {
    throw new HttpError(400, 'Invalid or missing file size');
  }
  if (size > config.maxUploadBytes) {
    throw new HttpError(413, `File is larger than the ${(config.maxUploadBytes / 1e9).toFixed(0)}GB upload limit`);
  }
  return size;
}

// Shared by the signed-in upload routes below and the public share-link
// upload routes (routes/share.js) - `uploader` is { userId } for a signed
// in user or { shareToken } for a visitor on an upload-enabled link.
export async function startSession({ uploader, ownerId, parentId, relativePath, name, mimeType, size, onConflict, replaceNodeId }) {
  const cleanName = sanitizeName(name);
  const session = createSession({
    uploader,
    ownerId,
    parentId,
    relativePath: typeof relativePath === 'string' ? relativePath : '',
    name: cleanName,
    mimeType: mimeType || mime.lookup(cleanName) || 'application/octet-stream',
    size,
    onConflict: onConflict === 'replace' ? 'replace' : 'rename',
    replaceNodeId: replaceNodeId || null,
    tempBlobName: crypto.randomUUID(),
  });
  await fsp.writeFile(blobPath(session.tempBlobName), Buffer.alloc(0));
  return session;
}

// Chunks are raw bytes, not JSON - parsed only on the chunk routes, keyed
// by the client sending Content-Type: application/octet-stream (the
// app-wide express.json() middleware ignores non-JSON content types, so
// the two coexist without conflict). Kept a bit above the client's own
// chunk size (see CHUNK_SIZE in web/src/api.js) so a legitimate chunk is
// never rejected as oversized.
export const rawChunkBody = express.raw({ type: '*/*', limit: '40mb' });

export async function writeChunk(req, res, session) {
  const offset = parseInt(req.headers['x-chunk-offset'], 10);
  if (!Number.isFinite(offset) || offset < 0) {
    return res.status(400).json({ error: 'Missing or invalid X-Chunk-Offset header' });
  }
  const chunk = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  try {
    const receivedBytes = await withSessionLock(session, async () => {
      if (session.completed || session.cancelled) throw new HttpError(409, 'Upload already finished');
      // A chunk at an offset already received means the client's own
      // response to that write was lost (e.g. the connection dropped right
      // after the server wrote it) - confirm the current state rather than
      // re-appending and corrupting the file with duplicate bytes.
      if (offset < session.receivedBytes) return session.receivedBytes;
      if (offset !== session.receivedBytes) {
        throw new HttpError(409, 'Offset mismatch', { receivedBytes: session.receivedBytes });
      }
      if (session.receivedBytes + chunk.length > session.size) {
        throw new HttpError(400, 'Chunk exceeds the declared file size');
      }
      await fsp.appendFile(blobPath(session.tempBlobName), chunk);
      session.receivedBytes += chunk.length;
      session.lastActivityAt = Date.now();
      return session.receivedBytes;
    });
    res.json({ receivedBytes });
  } catch (err) {
    sendError(res, err);
  }
}

// Re-checks, at the moment the file is actually filed away, that the place
// it's going still exists and the uploader may still put things there -
// an upload can run for hours, and the folder could be deleted (or access
// revoked) in the meantime.
function assertDestinationStillValid(session) {
  const { uploader } = session;
  if (session.replaceNodeId) {
    const node = findNodeById(session.replaceNodeId);
    const allowed =
      node &&
      !node.trashed &&
      node.type === 'file' &&
      uploader.userId &&
      (node.ownerId === uploader.userId || hasAccess(node, uploader.userId, 'edit'));
    if (!allowed) throw new HttpError(409, 'The file this was replacing no longer exists');
    return;
  }
  if (session.parentId === null) {
    if (uploader.userId !== session.ownerId) throw new HttpError(409, 'Destination folder no longer exists');
    return;
  }
  const parent = findNodeById(session.parentId);
  const usable =
    parent &&
    parent.type === 'folder' &&
    !parent.trashed &&
    parent.ownerId === session.ownerId &&
    (!uploader.userId || parent.ownerId === uploader.userId || hasAccess(parent, uploader.userId, 'upload'));
  if (!usable) throw new HttpError(409, 'The folder this was being uploaded to no longer exists');
}

async function fileSessionAway(session, { actorName, activityAction, activityDetails }) {
  assertDestinationStillValid(session);
  if (session.receivedBytes !== session.size) {
    throw new HttpError(400, 'Upload incomplete', { receivedBytes: session.receivedBytes, size: session.size });
  }
  const tempPath = blobPath(session.tempBlobName);
  const stat = await fsp.stat(tempPath).catch(() => null);
  if (!stat || stat.size !== session.size) {
    // Should be impossible with the per-session lock, but a mismatch here
    // means a corrupt file - refuse it outright rather than store it.
    await fsp.unlink(tempPath).catch(() => {});
    deleteSession(session.id);
    throw new HttpError(500, 'The uploaded file came out the wrong size on the server - please upload it again');
  }

  let fileSize = session.size;
  const owner = findUserById(session.ownerId);
  if (owner?.preferences?.compressImages) {
    const compressedSize = await compressImageInPlace(tempPath, { mimeType: session.mimeType, size: fileSize });
    if (compressedSize) fileSize = compressedSize;
  }
  const content = { blobName: session.tempBlobName, size: fileSize, mimeType: session.mimeType };
  const actorId = session.uploader.userId || session.ownerId;

  // Explicit "upload a new version of this file".
  if (session.replaceNodeId) {
    const node = findNodeById(session.replaceNodeId);
    await replaceFileContent(node, content);
    logActivity({ userId: actorId, username: actorName, action: 'new_version', targetName: node.name });
    return { node, replaced: true };
  }

  let targetParentId = session.parentId;
  if (session.relativePath) {
    const segments = session.relativePath.split('/').filter(Boolean);
    segments.pop(); // last segment is the filename itself, not a folder
    if (segments.length) {
      targetParentId = resolveFolderChain(session.ownerId, session.parentId, segments, new Map());
    }
  }

  // "Replace" chosen for a name clash: the existing file keeps its identity
  // (links, comments, people access) and its old content becomes a version.
  if (session.onConflict === 'replace') {
    const existing = findSibling(session.ownerId, targetParentId, session.name);
    const canReplace =
      existing &&
      existing.type === 'file' &&
      session.uploader.userId &&
      (existing.ownerId === session.uploader.userId || hasAccess(existing, session.uploader.userId, 'edit'));
    if (canReplace) {
      await replaceFileContent(existing, content);
      logActivity({ userId: actorId, username: actorName, action: 'new_version', targetName: existing.name, details: activityDetails });
      return { node: existing, replaced: true };
    }
  }

  const now = Date.now();
  const node = {
    id: crypto.randomUUID(),
    // Anything already holding the name stays put; this copy becomes
    // "name (1).ext" ("Keep both").
    name: uniqueName(session.ownerId, targetParentId, session.name),
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
  const contentText = await extractText(tempPath, { mimeType: session.mimeType, name: node.name, size: fileSize });
  if (contentText) node.contentText = contentText;
  const thumbnailBlobName = await maybeGenerateThumbnail(session.mimeType, tempPath);
  if (thumbnailBlobName) node.thumbnailBlobName = thumbnailBlobName;
  getState().nodes.push(node);
  logActivity({ userId: actorId, username: actorName, action: activityAction, targetName: node.name, details: activityDetails });
  return { node, replaced: false };
}

// Finishes a session exactly once: a retried "complete" (the first
// response lost in transit) gets the original result back rather than a
// second copy of the file or a confusing 404.
export function completeSession(session, activity) {
  return withSessionLock(session, async () => {
    if (session.completed) return session.result;
    if (session.cancelled) throw new HttpError(409, 'Upload was cancelled');
    try {
      const result = await fileSessionAway(session, activity);
      session.completed = true;
      session.lastActivityAt = Date.now();
      session.result = result;
      await save();
      return result;
    } catch (err) {
      // The destination vanished or the data is bad - nothing a retry of
      // this same session can fix, so free the temp file now.
      if (err instanceof HttpError && err.status === 409) {
        session.cancelled = true;
        await fsp.unlink(blobPath(session.tempBlobName)).catch(() => {});
        deleteSession(session.id);
      }
      throw err;
    }
  });
}

export function cancelSession(session) {
  return withSessionLock(session, async () => {
    if (session.completed) return;
    session.cancelled = true;
    deleteSession(session.id);
    await fsp.unlink(blobPath(session.tempBlobName)).catch(() => {});
  });
}

export { HttpError, sendError };

// ---- Signed-in upload routes ---------------------------------------------

// A resumable upload is one file per session: the client chunks the file
// and PUTs pieces sequentially, retrying from wherever the server says it
// actually got to if a chunk's response is lost to a network drop -
// instead of the whole file having to restart from byte zero.
router.post('/', requireFetchHeader, requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const size = parseSize(body.size);

    // "Upload a new version" of one specific existing file.
    if (body.replaceNodeId) {
      const node = findNodeById(body.replaceNodeId);
      const allowed =
        node && !node.trashed && node.type === 'file' && (node.ownerId === req.user.id || hasAccess(node, req.user.id, 'edit'));
      if (!allowed) throw new HttpError(404, 'Not found');
      assertQuota(node.ownerId, size - (node.size || 0));
      const session = await startSession({
        uploader: { userId: req.user.id },
        ownerId: node.ownerId,
        parentId: node.parentId,
        name: node.name,
        mimeType: body.mimeType,
        size,
        replaceNodeId: node.id,
      });
      return res.status(201).json({ sessionId: session.id });
    }

    const parentId = fromClientParentId(body.parentId);
    if (!assertParentIsUsableFolder(req, res, parentId, 'upload')) return;
    const parent = parentId ? findNodeById(parentId) : null;
    // Uploading into someone else's shared folder counts against THEIR
    // quota and creates files THEY own - not the collaborator's.
    const ownerId = parent ? parent.ownerId : req.user.id;
    assertQuota(ownerId, size);
    const session = await startSession({
      uploader: { userId: req.user.id },
      ownerId,
      parentId,
      relativePath: body.relativePath,
      name: body.name,
      mimeType: body.mimeType,
      size,
      onConflict: body.onConflict,
    });
    res.status(201).json({ sessionId: session.id });
  } catch (err) {
    sendError(res, err);
  }
});

function loadOwnSession(req, res) {
  const session = getSession(req.params.id);
  if (!session || session.uploader.userId !== req.user.id) {
    res.status(404).json({ error: 'Upload session not found or expired' });
    return null;
  }
  return session;
}

router.put('/:id/chunk', requireFetchHeader, requireAuth, rawChunkBody, async (req, res) => {
  const session = loadOwnSession(req, res);
  if (!session) return;
  await writeChunk(req, res, session);
});

router.post('/:id/complete', requireFetchHeader, requireAuth, async (req, res) => {
  const session = loadOwnSession(req, res);
  if (!session) return;
  try {
    const { node, replaced } = await completeSession(session, {
      actorName: req.user.username,
      activityAction: 'upload',
    });
    res.status(201).json({ item: serialize(node, req.user.id), replaced });
  } catch (err) {
    sendError(res, err);
  }
});

router.delete('/:id', requireFetchHeader, requireAuth, async (req, res) => {
  const session = loadOwnSession(req, res);
  if (!session) return;
  await cancelSession(session);
  res.json({ ok: true });
});

export default router;
