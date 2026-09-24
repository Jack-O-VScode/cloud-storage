import { Router } from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import mime from 'mime-types';
const uuid = crypto.randomUUID;
import { config } from '../config.js';
import { getState, save, findNodeById, childrenOf, allOwnedBy } from '../store.js';
import { requireAuth, requireFetchHeader, hashPassword } from '../auth.js';
import { blobPath, diskUsage } from '../lib/paths.js';
import { breadcrumb, isSelfOrDescendantMove, descendantsOf } from '../lib/tree.js';
import { streamZip } from '../lib/zip.js';

const router = Router();

function toClientParentId(parentId) {
  return parentId === null ? 'root' : parentId;
}
function fromClientParentId(parentId) {
  return !parentId || parentId === 'root' ? null : parentId;
}

// Strips path separators/control characters so a file or folder name can
// never be mistaken for a path segment - matters once names feed into zip
// entry paths, not just because it's confusing in the UI.
function sanitizeName(raw) {
  const cleaned = String(raw || '').replace(/[/\\\u0000-\u001f]/g, ' ').trim();
  return cleaned || 'Untitled';
}

function serialize(node) {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    parentId: toClientParentId(node.parentId),
    size: node.size || 0,
    mimeType: node.mimeType || null,
    trashed: Boolean(node.trashed),
    trashedAt: node.trashedAt || null,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    shared: Boolean(node.shareToken),
    shareToken: node.shareToken || null,
    shareExpiresAt: node.shareExpiresAt || null,
    sharePasswordProtected: Boolean(node.sharePasswordHash),
  };
}

// Ownership + existence guard shared by every mutating route below.
function loadOwnedNode(req, res) {
  const node = findNodeById(req.params.id);
  if (!node || node.ownerId !== req.user.id) {
    res.status(404).json({ error: 'Not found' });
    return null;
  }
  return node;
}

function assertParentIsUsableFolder(req, res, parentId) {
  if (parentId === null) return true;
  const parent = findNodeById(parentId);
  if (!parent || parent.ownerId !== req.user.id || parent.type !== 'folder' || parent.trashed) {
    res.status(400).json({ error: 'Destination folder does not exist' });
    return false;
  }
  return true;
}

router.get('/', requireAuth, (req, res) => {
  const parentId = fromClientParentId(req.query.parentId);
  if (!assertParentIsUsableFolder(req, res, parentId)) return;
  const items = childrenOf(req.user.id, parentId).sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  const parent = parentId ? findNodeById(parentId) : null;
  res.json({
    items: items.map(serialize),
    breadcrumb: parent ? breadcrumb(parent).map(serialize) : [],
  });
});

router.get('/trash', requireAuth, (req, res) => {
  const items = allOwnedBy(req.user.id).filter((n) => n.trashed);
  items.sort((a, b) => (b.trashedAt || 0) - (a.trashedAt || 0));
  res.json({ items: items.map(serialize) });
});

router.get('/search', requireAuth, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.json({ items: [] });
  const items = allOwnedBy(req.user.id).filter(
    (n) => !n.trashed && n.name.toLowerCase().includes(q)
  );
  res.json({ items: items.map(serialize) });
});

router.get('/:id', requireAuth, (req, res) => {
  const node = loadOwnedNode(req, res);
  if (!node) return;
  res.json({ item: serialize(node), breadcrumb: breadcrumb(node).map(serialize) });
});

router.post('/folder', requireFetchHeader, requireAuth, (req, res) => {
  const rawName = String(req.body?.name || '').trim();
  const parentId = fromClientParentId(req.body?.parentId);
  if (!rawName) return res.status(400).json({ error: 'Folder name is required' });
  if (!assertParentIsUsableFolder(req, res, parentId)) return;
  const state = getState();
  const now = Date.now();
  const node = {
    id: uuid(),
    name: sanitizeName(rawName),
    type: 'folder',
    parentId,
    ownerId: req.user.id,
    trashed: false,
    trashedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  state.nodes.push(node);
  save();
  res.status(201).json({ item: serialize(node) });
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.blobDir),
    filename: (req, file, cb) => cb(null, uuid()),
  }),
  limits: {
    fileSize: config.maxUploadBytes,
    // No `files` limit here - omitting it (rather than passing a number to
    // upload.array below) means an unlimited number of files per batch.
    // fieldSize is bumped because the relativePaths JSON field (one path
    // per file, for folder uploads) can otherwise hit busboy's 1MB default
    // on a folder with tens of thousands of files.
    fieldSize: 50 * 1024 * 1024,
  },
});

// Resolves (creating as needed) the chain of subfolders described by
// `segments` under `baseParentId`, reusing folders already created earlier
// in the same upload batch (via `cache`) so a folder with many files isn't
// recreated once per file.
function resolveFolderChain(ownerId, baseParentId, segments, cache) {
  let parentId = baseParentId;
  for (const name of segments) {
    const cacheKey = `${parentId ?? 'root'}\u0000${name}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      parentId = cached;
      continue;
    }
    const state = getState();
    let folder = state.nodes.find(
      (n) =>
        n.ownerId === ownerId &&
        n.parentId === parentId &&
        n.type === 'folder' &&
        !n.trashed &&
        n.name === name
    );
    if (!folder) {
      const now = Date.now();
      folder = {
        id: uuid(),
        name,
        type: 'folder',
        parentId,
        ownerId,
        trashed: false,
        trashedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      state.nodes.push(folder);
    }
    cache.set(cacheKey, folder.id);
    parentId = folder.id;
  }
  return parentId;
}

router.post('/upload', requireFetchHeader, requireAuth, upload.array('files'), async (req, res) => {
  const parentId = fromClientParentId(req.body?.parentId);
  if (!assertParentIsUsableFolder(req, res, parentId)) {
    // Clean up anything multer already wrote to disk before we reject.
    await Promise.all((req.files || []).map((f) => fsp.unlink(f.path).catch(() => {})));
    return;
  }

  // Optional JSON array of relative paths (e.g. "Photos/2024/img.jpg"),
  // one per uploaded file in the same order, sent when uploading a folder
  // (drag-and-drop or the folder picker) so its structure can be recreated
  // as real subfolders instead of dumping every file flat into parentId.
  let relativePaths = [];
  if (req.body?.relativePaths) {
    try {
      relativePaths = JSON.parse(req.body.relativePaths);
    } catch {
      relativePaths = [];
    }
  }

  const state = getState();
  const now = Date.now();
  const created = [];
  const folderCache = new Map();

  (req.files || []).forEach((file, i) => {
    let targetParentId = parentId;
    const relPath = relativePaths[i];
    if (relPath) {
      const segments = relPath.split('/').filter(Boolean);
      segments.pop(); // last segment is the filename itself, not a folder
      if (segments.length) {
        targetParentId = resolveFolderChain(req.user.id, parentId, segments, folderCache);
      }
    }
    const node = {
      id: uuid(),
      name: sanitizeName(file.originalname),
      type: 'file',
      parentId: targetParentId,
      ownerId: req.user.id,
      size: file.size,
      mimeType: file.mimetype || mime.lookup(file.originalname) || 'application/octet-stream',
      blobName: file.filename,
      trashed: false,
      trashedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    state.nodes.push(node);
    created.push(node);
  });

  await save();
  res.status(201).json({ items: created.map(serialize) });
});

router.post('/zip', requireFetchHeader, requireAuth, async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const nodes = ids
    .map((id) => findNodeById(id))
    .filter((n) => n && n.ownerId === req.user.id && !n.trashed);
  if (!nodes.length) return res.status(400).json({ error: 'No items selected' });
  const zipName = nodes.length === 1 ? `${nodes[0].name}.zip` : 'download.zip';
  await streamZip(res, nodes, zipName);
});

router.patch('/:id', requireFetchHeader, requireAuth, (req, res) => {
  const node = loadOwnedNode(req, res);
  if (!node) return;
  const { name, parentId, trashed } = req.body || {};

  if (typeof name === 'string') {
    const trimmed = name.trim();
    if (!trimmed) return res.status(400).json({ error: 'Name cannot be empty' });
    node.name = sanitizeName(trimmed);
  }

  if (parentId !== undefined) {
    const targetParentId = fromClientParentId(parentId);
    if (!assertParentIsUsableFolder(req, res, targetParentId)) return;
    if (node.type === 'folder' && isSelfOrDescendantMove(node.id, targetParentId)) {
      return res.status(400).json({ error: "Can't move a folder into itself" });
    }
    node.parentId = targetParentId;
  }

  if (typeof trashed === 'boolean') {
    node.trashed = trashed;
    node.trashedAt = trashed ? Date.now() : null;
    // Trashing/restoring a folder cascades to everything inside it so the
    // trash view and quota accounting stay consistent with what's visible.
    for (const d of descendantsOf(node.id)) {
      d.trashed = trashed;
      d.trashedAt = trashed ? Date.now() : null;
    }
  }

  node.updatedAt = Date.now();
  save();
  res.json({ item: serialize(node) });
});

async function purgeNode(node) {
  if (node.type === 'file' && node.blobName) {
    await fsp.unlink(blobPath(node.blobName)).catch(() => {});
  }
}

router.delete('/trash', requireFetchHeader, requireAuth, async (req, res) => {
  const state = getState();
  const trashedIds = new Set(
    state.nodes.filter((n) => n.ownerId === req.user.id && n.trashed).map((n) => n.id)
  );
  await Promise.all(
    state.nodes.filter((n) => trashedIds.has(n.id)).map((n) => purgeNode(n))
  );
  state.nodes = state.nodes.filter((n) => !trashedIds.has(n.id));
  await save();
  res.json({ ok: true });
});

router.delete('/:id', requireFetchHeader, requireAuth, async (req, res) => {
  const node = loadOwnedNode(req, res);
  if (!node) return;
  if (!node.trashed) {
    return res.status(400).json({ error: 'Move to trash before deleting permanently' });
  }
  const state = getState();
  const toRemove = [node, ...descendantsOf(node.id)];
  await Promise.all(toRemove.map((n) => purgeNode(n)));
  const removeIds = new Set(toRemove.map((n) => n.id));
  state.nodes = state.nodes.filter((n) => !removeIds.has(n.id));
  await save();
  res.json({ ok: true });
});

router.post('/:id/share', requireFetchHeader, requireAuth, (req, res) => {
  const node = loadOwnedNode(req, res);
  if (!node) return;
  const { expiresInMs, password } = req.body || {};
  // Keep the existing token (if any) so changing just the expiry/password
  // doesn't invalidate a link already handed out. Both settings are only
  // touched when explicitly present in the body - the client can't safely
  // re-send a password it's never given back, so omitting the field means
  // "leave it as-is" rather than "clear it".
  if (!node.shareToken) node.shareToken = crypto.randomBytes(24).toString('base64url');
  if (expiresInMs !== undefined) {
    node.shareExpiresAt = typeof expiresInMs === 'number' && expiresInMs > 0 ? Date.now() + expiresInMs : null;
  }
  if (password !== undefined) {
    node.sharePasswordHash = password ? hashPassword(password) : null;
  }
  save();
  res.json({ item: serialize(node), shareToken: node.shareToken });
});

router.delete('/:id/share', requireFetchHeader, requireAuth, (req, res) => {
  const node = loadOwnedNode(req, res);
  if (!node) return;
  node.shareToken = null;
  node.shareExpiresAt = null;
  node.sharePasswordHash = null;
  save();
  res.json({ item: serialize(node) });
});

function streamFile(req, res, node) {
  const filePath = blobPath(node.blobName);
  fs.stat(filePath, (err, stat) => {
    if (err) return res.status(404).json({ error: 'File missing on disk' });
    res.setHeader('Content-Type', node.mimeType || 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader(
      'Content-Disposition',
      `${req.query.download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(node.name)}`
    );

    const range = req.headers.range;
    if (!range) {
      res.setHeader('Content-Length', stat.size);
      fs.createReadStream(filePath).pipe(res);
      return;
    }
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    let start = match?.[1] ? parseInt(match[1], 10) : 0;
    let end = match?.[2] ? parseInt(match[2], 10) : stat.size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= stat.size) {
      res.setHeader('Content-Range', `bytes */${stat.size}`);
      return res.status(416).end();
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('Content-Length', end - start + 1);
    fs.createReadStream(filePath, { start, end }).pipe(res);
  });
}

router.get('/:id/download', requireAuth, (req, res) => {
  const node = loadOwnedNode(req, res);
  if (!node) return;
  if (node.type !== 'file') return res.status(400).json({ error: 'Not a file' });
  streamFile(req, res, node);
});

export { streamFile };
export default router;
