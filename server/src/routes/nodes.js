import { Router } from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import mime from 'mime-types';
const uuid = crypto.randomUUID;
import { config } from '../config.js';
import {
  getState,
  save,
  findNodeById,
  findUserById,
  childrenOf,
  allOwnedBy,
  logActivity,
  findBundleById,
} from '../store.js';
import { requireAuth, requireFetchHeader, hashPassword } from '../auth.js';
import { blobPath, diskUsage } from '../lib/paths.js';
import { isSelfOrDescendantMove, descendantsOf } from '../lib/tree.js';
import { streamZip } from '../lib/zip.js';
import { purgeNodeBlob } from '../lib/purge.js';
import { extractText } from '../lib/textExtract.js';
import { hasAccess, breadcrumbFor } from '../lib/access.js';

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
    shareUploadEnabled: node.type === 'folder' ? Boolean(node.shareUploadEnabled) : false,
    starred: Boolean(node.starred),
    versionCount: (node.versions || []).length,
    commentCount: (node.comments || []).length,
  };
}

function serializeComment(c) {
  return { id: c.id, userId: c.userId, username: c.username, text: c.text, createdAt: c.createdAt };
}

function serializeBundle(bundle) {
  return {
    id: bundle.id,
    token: bundle.token,
    expiresAt: bundle.expiresAt || null,
    passwordProtected: Boolean(bundle.passwordHash),
    items: bundle.nodeIds
      .map((id) => findNodeById(id))
      .filter((n) => n && !n.trashed)
      .map(serialize),
  };
}

// Ownership + existence guard for routes that stay owner-only even for a
// collaborator with edit access - sharing/grant management and permanent
// delete/trash management.
function loadOwnedNode(req, res) {
  const node = findNodeById(req.params.id);
  if (!node || node.ownerId !== req.user.id) {
    res.status(404).json({ error: 'Not found' });
    return null;
  }
  return node;
}

// Like loadOwnedNode, but also succeeds for a collaborator who holds at
// least `requiredLevel` access via a grant on an ancestor folder. A grantee
// can never reach into trash - only the owner's own trash view/actions do.
function loadAccessibleNode(req, res, requiredLevel = 'view') {
  const node = findNodeById(req.params.id);
  if (!node) {
    res.status(404).json({ error: 'Not found' });
    return null;
  }
  if (node.ownerId === req.user.id) return node;
  if (!node.trashed && hasAccess(node, req.user.id, requiredLevel)) return node;
  res.status(404).json({ error: 'Not found' });
  return null;
}

function assertParentIsUsableFolder(req, res, parentId, requiredLevel = 'view') {
  if (parentId === null) return true;
  const parent = findNodeById(parentId);
  if (!parent || parent.type !== 'folder' || parent.trashed) {
    res.status(400).json({ error: 'Destination folder does not exist' });
    return false;
  }
  if (parent.ownerId === req.user.id || hasAccess(parent, req.user.id, requiredLevel)) return true;
  res.status(400).json({ error: 'Destination folder does not exist' });
  return false;
}

router.get('/', requireAuth, (req, res) => {
  const parentId = fromClientParentId(req.query.parentId);
  if (!assertParentIsUsableFolder(req, res, parentId, 'view')) return;
  const parent = parentId ? findNodeById(parentId) : null;
  // A null parentId always means "my own drive root" - a grant can only
  // ever target a specific folder, never someone else's whole root.
  const items = (parent ? getState().nodes.filter((n) => n.parentId === parent.id && !n.trashed) : childrenOf(req.user.id, parentId)).sort(
    (a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    }
  );
  res.json({
    items: items.map(serialize),
    breadcrumb: parent ? breadcrumbFor(parent, req.user.id).map(serialize) : [],
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
  const items = allOwnedBy(req.user.id).filter((n) => {
    if (n.trashed) return false;
    if (n.name.toLowerCase().includes(q)) return true;
    return Boolean(n.contentText && n.contentText.toLowerCase().includes(q));
  });
  // Content-only matches (the query isn't in the name) get flagged so the
  // UI can explain why a result showed up.
  res.json({
    items: items.map((n) => ({
      ...serialize(n),
      contentMatch: !n.name.toLowerCase().includes(q) && Boolean(n.contentText),
    })),
  });
});

router.get('/starred', requireAuth, (req, res) => {
  const items = allOwnedBy(req.user.id).filter((n) => n.starred && !n.trashed);
  items.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  res.json({ items: items.map(serialize) });
});

const RECENT_LIMIT = 50;

// "Recent" is files only (a folder has no content of its own to have
// "opened" recently) and ranked by their own last-modified time - cheap
// and good enough without a separate access-log to maintain.
router.get('/recent', requireAuth, (req, res) => {
  const items = allOwnedBy(req.user.id)
    .filter((n) => n.type === 'file' && !n.trashed)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, RECENT_LIMIT);
  res.json({ items: items.map(serialize) });
});

router.get('/:id', requireAuth, (req, res) => {
  const node = loadAccessibleNode(req, res, 'view');
  if (!node) return;
  res.json({ item: serialize(node), breadcrumb: breadcrumbFor(node, req.user.id).map(serialize) });
});

router.post('/folder', requireFetchHeader, requireAuth, (req, res) => {
  const rawName = String(req.body?.name || '').trim();
  const parentId = fromClientParentId(req.body?.parentId);
  if (!rawName) return res.status(400).json({ error: 'Folder name is required' });
  if (!assertParentIsUsableFolder(req, res, parentId, 'upload')) return;
  // A folder created inside someone else's shared folder belongs to THEM
  // (like the existing upload-enabled public share links), not the
  // collaborator who created it.
  const parent = parentId ? findNodeById(parentId) : null;
  const ownerId = parent ? parent.ownerId : req.user.id;
  const state = getState();
  const now = Date.now();
  const node = {
    id: uuid(),
    name: sanitizeName(rawName),
    type: 'folder',
    parentId,
    ownerId,
    trashed: false,
    trashedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  state.nodes.push(node);
  logActivity({ userId: req.user.id, username: req.user.username, action: 'create_folder', targetName: node.name });
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
  if (!assertParentIsUsableFolder(req, res, parentId, 'upload')) {
    // Clean up anything multer already wrote to disk before we reject.
    await Promise.all((req.files || []).map((f) => fsp.unlink(f.path).catch(() => {})));
    return;
  }
  // Uploading into someone else's shared folder counts against THEIR quota
  // and creates files THEY own, same as the existing upload-enabled public
  // share links - not the collaborator doing the uploading.
  const parent = parentId ? findNodeById(parentId) : null;
  const ownerId = parent ? parent.ownerId : req.user.id;

  const quotaBytes = findUserById(ownerId)?.quotaBytes;
  if (quotaBytes) {
    const incomingBytes = (req.files || []).reduce((sum, f) => sum + f.size, 0);
    const currentlyUsed = allOwnedBy(ownerId)
      .filter((n) => n.type === 'file' && !n.trashed)
      .reduce((sum, n) => sum + (n.size || 0), 0);
    if (currentlyUsed + incomingBytes > quotaBytes) {
      await Promise.all((req.files || []).map((f) => fsp.unlink(f.path).catch(() => {})));
      return res.status(413).json({
        error: `This upload would exceed the storage quota (${(quotaBytes / 1e9).toFixed(1)}GB). Free up space or ask an admin to raise the quota.`,
      });
    }
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

  for (let i = 0; i < (req.files || []).length; i++) {
    const file = req.files[i];
    let targetParentId = parentId;
    const relPath = relativePaths[i];
    if (relPath) {
      const segments = relPath.split('/').filter(Boolean);
      segments.pop(); // last segment is the filename itself, not a folder
      if (segments.length) {
        targetParentId = resolveFolderChain(ownerId, parentId, segments, folderCache);
      }
    }
    const name = sanitizeName(file.originalname);
    const mimeType = file.mimetype || mime.lookup(file.originalname) || 'application/octet-stream';
    const node = {
      id: uuid(),
      name,
      type: 'file',
      parentId: targetParentId,
      ownerId,
      size: file.size,
      mimeType,
      blobName: file.filename,
      trashed: false,
      trashedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const contentText = await extractText(blobPath(file.filename), { mimeType, name, size: file.size });
    if (contentText) node.contentText = contentText;
    state.nodes.push(node);
    created.push(node);
  }

  if (created.length) {
    logActivity({
      userId: req.user.id,
      username: req.user.username,
      action: 'upload',
      targetName: created.length === 1 ? created[0].name : `${created.length} files`,
    });
  }
  await save();
  res.status(201).json({ items: created.map(serialize) });
});

router.post('/zip', requireFetchHeader, requireAuth, async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const nodes = ids
    .map((id) => findNodeById(id))
    .filter((n) => n && !n.trashed && (n.ownerId === req.user.id || hasAccess(n, req.user.id, 'view')));
  if (!nodes.length) return res.status(400).json({ error: 'No items selected' });
  const zipName = nodes.length === 1 ? `${nodes[0].name}.zip` : 'download.zip';
  await streamZip(res, nodes, zipName);
});

router.patch('/:id', requireFetchHeader, requireAuth, (req, res) => {
  const node = loadAccessibleNode(req, res, 'edit');
  if (!node) return;
  const { name, parentId, trashed, starred } = req.body || {};
  const activityBase = { userId: req.user.id, username: req.user.username };
  let contentChanged = false;

  if (typeof name === 'string') {
    const trimmed = name.trim();
    if (!trimmed) return res.status(400).json({ error: 'Name cannot be empty' });
    const oldName = node.name;
    node.name = sanitizeName(trimmed);
    if (node.name !== oldName) {
      logActivity({ ...activityBase, action: 'rename', targetName: oldName, details: `to "${node.name}"` });
      contentChanged = true;
    }
  }

  if (parentId !== undefined) {
    const targetParentId = fromClientParentId(parentId);
    if (!assertParentIsUsableFolder(req, res, targetParentId, 'edit')) return;
    // A move can never cross into a different owner's tree - ownership is
    // tracked only via ownerId, not by where a node happens to sit, so
    // "moving" a shared item into your own drive would silently orphan it
    // from both the owner's and your own view of their storage.
    const targetOwnerId = targetParentId ? findNodeById(targetParentId).ownerId : req.user.id;
    if (targetOwnerId !== node.ownerId) {
      return res.status(400).json({ error: "Can't move a shared item outside its owner's drive" });
    }
    if (node.type === 'folder' && isSelfOrDescendantMove(node.id, targetParentId)) {
      return res.status(400).json({ error: "Can't move a folder into itself" });
    }
    node.parentId = targetParentId;
    logActivity({ ...activityBase, action: 'move', targetName: node.name });
    contentChanged = true;
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
    logActivity({ ...activityBase, action: trashed ? 'trash' : 'restore', targetName: node.name });
    contentChanged = true;
  }

  // Starring is metadata about the node, not a change to it - it shouldn't
  // bump updatedAt, since that timestamp drives the "Recent files" view.
  // It's also personal to the owner's own dashboard (there's one boolean
  // per node, not per viewer), so a collaborator can't star someone else's
  // shared item into view.
  if (typeof starred === 'boolean' && node.ownerId === req.user.id) {
    node.starred = starred;
  }

  if (contentChanged) node.updatedAt = Date.now();
  save();
  res.json({ item: serialize(node) });
});

const purgeNode = purgeNodeBlob;

router.delete('/trash', requireFetchHeader, requireAuth, async (req, res) => {
  const state = getState();
  const trashedIds = new Set(
    state.nodes.filter((n) => n.ownerId === req.user.id && n.trashed).map((n) => n.id)
  );
  await Promise.all(
    state.nodes.filter((n) => trashedIds.has(n.id)).map((n) => purgeNode(n))
  );
  state.nodes = state.nodes.filter((n) => !trashedIds.has(n.id));
  if (trashedIds.size) {
    logActivity({
      userId: req.user.id,
      username: req.user.username,
      action: 'empty_trash',
      targetName: `${trashedIds.size} item(s)`,
    });
  }
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
  logActivity({
    userId: req.user.id,
    username: req.user.username,
    action: 'delete_forever',
    targetName: node.name,
  });
  await save();
  res.json({ ok: true });
});

router.post('/:id/share', requireFetchHeader, requireAuth, (req, res) => {
  const node = loadOwnedNode(req, res);
  if (!node) return;
  const { expiresInMs, password, uploadEnabled } = req.body || {};
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
  if (uploadEnabled !== undefined && node.type === 'folder') {
    node.shareUploadEnabled = Boolean(uploadEnabled);
  }
  logActivity({ userId: req.user.id, username: req.user.username, action: 'share', targetName: node.name });
  save();
  res.json({ item: serialize(node), shareToken: node.shareToken });
});

router.delete('/:id/share', requireFetchHeader, requireAuth, (req, res) => {
  const node = loadOwnedNode(req, res);
  if (!node) return;
  node.shareToken = null;
  node.shareExpiresAt = null;
  node.sharePasswordHash = null;
  node.shareUploadEnabled = false;
  logActivity({ userId: req.user.id, username: req.user.username, action: 'unshare', targetName: node.name });
  save();
  res.json({ item: serialize(node) });
});

// A "bundle" shares an arbitrary set of files/folders (possibly from
// different parents) behind one link/token, distinct from the single-node
// share above which always ties a token to exactly one node's subtree.
router.post('/share-bundle', requireFetchHeader, requireAuth, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids)] : [];
  const items = ids
    .map((id) => findNodeById(id))
    .filter((n) => n && n.ownerId === req.user.id && !n.trashed);
  if (!items.length) return res.status(400).json({ error: 'No items selected' });

  const state = getState();
  const bundle = {
    id: uuid(),
    token: crypto.randomBytes(24).toString('base64url'),
    ownerId: req.user.id,
    nodeIds: items.map((n) => n.id),
    passwordHash: null,
    expiresAt: null,
    createdAt: Date.now(),
  };
  state.bundles.push(bundle);
  logActivity({
    userId: req.user.id,
    username: req.user.username,
    action: 'share',
    targetName: items.length === 1 ? items[0].name : `${items.length} items`,
  });
  save();
  res.status(201).json({ bundle: serializeBundle(bundle) });
});

router.patch('/share-bundle/:id', requireFetchHeader, requireAuth, (req, res) => {
  const bundle = findBundleById(req.params.id);
  if (!bundle || bundle.ownerId !== req.user.id) return res.status(404).json({ error: 'Not found' });
  const { expiresInMs, password } = req.body || {};
  if (expiresInMs !== undefined) {
    bundle.expiresAt = typeof expiresInMs === 'number' && expiresInMs > 0 ? Date.now() + expiresInMs : null;
  }
  if (password !== undefined) {
    bundle.passwordHash = password ? hashPassword(password) : null;
  }
  save();
  res.json({ bundle: serializeBundle(bundle) });
});

router.delete('/share-bundle/:id', requireFetchHeader, requireAuth, (req, res) => {
  const bundle = findBundleById(req.params.id);
  if (!bundle || bundle.ownerId !== req.user.id) return res.status(404).json({ error: 'Not found' });
  const state = getState();
  state.bundles = state.bundles.filter((b) => b.id !== bundle.id);
  logActivity({ userId: req.user.id, username: req.user.username, action: 'unshare', targetName: 'shared selection' });
  save();
  res.json({ ok: true });
});

const MAX_VERSIONS = 10;

// Re-uploading over an existing file (rather than uploading it fresh)
// keeps the previous blob around as a version instead of overwriting it
// silently, so a bad overwrite is always recoverable.
router.post('/:id/version', requireFetchHeader, requireAuth, upload.single('file'), async (req, res) => {
  const node = loadAccessibleNode(req, res, 'edit');
  if (!node) {
    if (req.file) await fsp.unlink(req.file.path).catch(() => {});
    return;
  }
  if (node.type !== 'file') {
    if (req.file) await fsp.unlink(req.file.path).catch(() => {});
    return res.status(400).json({ error: 'Not a file' });
  }
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  const quotaBytes = findUserById(node.ownerId)?.quotaBytes;
  if (quotaBytes) {
    const currentlyUsed = allOwnedBy(node.ownerId)
      .filter((n) => n.type === 'file' && !n.trashed)
      .reduce((sum, n) => sum + (n.size || 0), 0);
    const netIncrease = req.file.size - (node.size || 0);
    if (netIncrease > 0 && currentlyUsed + netIncrease > quotaBytes) {
      await fsp.unlink(req.file.path).catch(() => {});
      return res.status(413).json({ error: 'This new version would exceed your storage quota.' });
    }
  }

  node.versions ||= [];
  node.versions.push({
    id: uuid(),
    blobName: node.blobName,
    size: node.size,
    mimeType: node.mimeType,
    createdAt: node.updatedAt || node.createdAt,
  });
  while (node.versions.length > MAX_VERSIONS) {
    const dropped = node.versions.shift();
    await fsp.unlink(blobPath(dropped.blobName)).catch(() => {});
  }

  const mimeType = req.file.mimetype || mime.lookup(req.file.originalname) || 'application/octet-stream';
  node.blobName = req.file.filename;
  node.size = req.file.size;
  node.mimeType = mimeType;
  node.updatedAt = Date.now();
  const contentText = await extractText(blobPath(req.file.filename), { mimeType, name: node.name, size: req.file.size });
  if (contentText) node.contentText = contentText;
  else delete node.contentText;

  logActivity({ userId: req.user.id, username: req.user.username, action: 'new_version', targetName: node.name });
  await save();
  res.status(201).json({ item: serialize(node) });
});

router.get('/:id/versions', requireAuth, (req, res) => {
  const node = loadAccessibleNode(req, res, 'view');
  if (!node) return;
  const versions = (node.versions || [])
    .map((v) => ({ id: v.id, size: v.size, mimeType: v.mimeType, createdAt: v.createdAt }))
    .sort((a, b) => b.createdAt - a.createdAt);
  res.json({ versions });
});

router.get('/:id/versions/:versionId/download', requireAuth, (req, res) => {
  const node = loadAccessibleNode(req, res, 'view');
  if (!node) return;
  const version = (node.versions || []).find((v) => v.id === req.params.versionId);
  if (!version) return res.status(404).json({ error: 'Version not found' });
  streamFile(req, res, { blobName: version.blobName, mimeType: version.mimeType, name: node.name });
});

router.post('/:id/versions/:versionId/restore', requireFetchHeader, requireAuth, async (req, res) => {
  const node = loadAccessibleNode(req, res, 'edit');
  if (!node) return;
  const versions = node.versions || [];
  const idx = versions.findIndex((v) => v.id === req.params.versionId);
  if (idx === -1) return res.status(404).json({ error: 'Version not found' });
  const version = versions[idx];

  // The version being restored from becomes a version itself, in the same
  // slot, so restoring is symmetric - you can always undo a restore the
  // same way, and the total version count never grows from this.
  versions[idx] = {
    id: uuid(),
    blobName: node.blobName,
    size: node.size,
    mimeType: node.mimeType,
    createdAt: node.updatedAt || node.createdAt,
  };
  node.versions = versions;

  node.blobName = version.blobName;
  node.size = version.size;
  node.mimeType = version.mimeType;
  node.updatedAt = Date.now();
  const contentText = await extractText(blobPath(version.blobName), {
    mimeType: version.mimeType,
    name: node.name,
    size: version.size,
  });
  if (contentText) node.contentText = contentText;
  else delete node.contentText;

  logActivity({ userId: req.user.id, username: req.user.username, action: 'restore_version', targetName: node.name });
  await save();
  res.json({ item: serialize(node) });
});

const MAX_COMMENT_LENGTH = 2000;

router.get('/:id/comments', requireAuth, (req, res) => {
  const node = loadAccessibleNode(req, res, 'view');
  if (!node) return;
  res.json({ comments: (node.comments || []).map(serializeComment) });
});

router.post('/:id/comments', requireFetchHeader, requireAuth, (req, res) => {
  const node = loadAccessibleNode(req, res, 'view');
  if (!node) return;
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Comment cannot be empty' });
  if (text.length > MAX_COMMENT_LENGTH) {
    return res.status(400).json({ error: `Comment is too long (max ${MAX_COMMENT_LENGTH} characters)` });
  }
  node.comments ||= [];
  const comment = {
    id: uuid(),
    userId: req.user.id,
    username: req.user.username,
    text,
    createdAt: Date.now(),
  };
  node.comments.push(comment);
  save();
  res.status(201).json({ comments: node.comments.map(serializeComment) });
});

router.delete('/:id/comments/:commentId', requireFetchHeader, requireAuth, (req, res) => {
  const node = loadAccessibleNode(req, res, 'view');
  if (!node) return;
  const comments = node.comments || [];
  const comment = comments.find((c) => c.id === req.params.commentId);
  if (!comment) return res.status(404).json({ error: 'Comment not found' });
  // Only the person who wrote a comment can remove it - "view" access to
  // the node is not moderation rights over other people's notes on it.
  if (comment.userId !== req.user.id) return res.status(403).json({ error: 'Not your comment' });
  node.comments = comments.filter((c) => c.id !== comment.id);
  save();
  res.json({ comments: node.comments.map(serializeComment) });
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
  const node = loadAccessibleNode(req, res, 'view');
  if (!node) return;
  if (node.type !== 'file') return res.status(400).json({ error: 'Not a file' });
  streamFile(req, res, node);
});

export { streamFile };
export default router;
