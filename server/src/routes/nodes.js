import { Router } from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
const uuid = crypto.randomUUID;
import {
  getState,
  save,
  findNodeById,
  findUserById,
  childrenOf,
  allOwnedBy,
  logActivity,
  findBundleById,
  grantsForNode,
} from '../store.js';
import { requireAuth, requireFetchHeader, hashPassword } from '../auth.js';
import { blobPath } from '../lib/paths.js';
import { isSelfOrDescendantMove, buildChildrenIndex } from '../lib/tree.js';
import { streamZip } from '../lib/zip.js';
import { extractText } from '../lib/textExtract.js';
import { hasAccess, breadcrumbFor, viewerRole, nodesSharedWith } from '../lib/access.js';
import { trashNode, restoreNode, isTopLevelTrashed, removeNodesPermanently } from '../lib/trash.js';
import { maybeGenerateThumbnail } from '../lib/versions.js';
import { sanitizeName, findSibling, uniqueName } from '../lib/names.js';

const router = Router();

function toClientParentId(parentId) {
  return parentId === null ? 'root' : parentId;
}
function fromClientParentId(parentId) {
  return !parentId || parentId === 'root' ? null : parentId;
}

function isLinkExpired(expiresAt) {
  return Boolean(expiresAt) && Date.now() > expiresAt;
}

// `viewerId` is who's asking. Sharing details (links, who else has access)
// are only ever included for the item's owner - a collaborator browsing a
// shared folder mustn't be able to read the owner's public link tokens off
// the listing. `access` tells the UI what that viewer may do with the item.
function serialize(node, viewerId) {
  const out = {
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
    starred: Boolean(node.starred),
    versionCount: (node.versions || []).length,
    commentCount: (node.comments || []).length,
    access: viewerId ? viewerRole(node, viewerId) : 'owner',
  };
  if (viewerId && node.ownerId !== viewerId) {
    const owner = findUserById(node.ownerId);
    out.ownerUsername = owner?.username || null;
    return out;
  }
  const sharedWithCount = grantsForNode(node.id).length;
  const inLinkBundle = getState().bundles.some((b) => b.nodeIds.includes(node.id));
  out.shareToken = node.shareToken || null;
  out.shareExpiresAt = node.shareExpiresAt || null;
  out.shareExpired = Boolean(node.shareToken) && isLinkExpired(node.shareExpiresAt);
  out.sharePasswordProtected = Boolean(node.sharePasswordHash);
  out.shareUploadEnabled = node.type === 'folder' ? Boolean(node.shareUploadEnabled) : false;
  out.sharedWithCount = sharedWithCount;
  out.inLinkBundle = inLinkBundle;
  out.shared = Boolean(node.shareToken) || sharedWithCount > 0 || inLinkBundle;
  return out;
}

function serializeComment(c) {
  return { id: c.id, userId: c.userId, username: c.username, text: c.text, createdAt: c.createdAt };
}

function serializeBundle(bundle) {
  return {
    id: bundle.id,
    token: bundle.token,
    expiresAt: bundle.expiresAt || null,
    expired: isLinkExpired(bundle.expiresAt),
    passwordProtected: Boolean(bundle.passwordHash),
    createdAt: bundle.createdAt,
    items: bundle.nodeIds
      .map((id) => findNodeById(id))
      .filter((n) => n && !n.trashed)
      .map((n) => serialize(n, bundle.ownerId)),
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

const SORT_FIELDS = new Set(['name', 'size', 'updatedAt']);
const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 500;

// Folders always sort before files; within each group, by whatever field
// the caller asked for.
function compareNodes(a, b, sortBy, sortDir) {
  if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
  let cmp;
  if (sortBy === 'size') cmp = (a.size || 0) - (b.size || 0);
  else if (sortBy === 'updatedAt') cmp = (a.updatedAt || 0) - (b.updatedAt || 0);
  else cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  return sortDir === 'desc' ? -cmp : cmp;
}

router.get('/', requireAuth, (req, res) => {
  const parentId = fromClientParentId(req.query.parentId);
  if (!assertParentIsUsableFolder(req, res, parentId, 'view')) return;
  const parent = parentId ? findNodeById(parentId) : null;
  const uid = req.user.id;

  const sortBy = SORT_FIELDS.has(req.query.sortBy) ? req.query.sortBy : 'name';
  const sortDir = req.query.sortDir === 'desc' ? 'desc' : 'asc';
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_PAGE_SIZE));

  // A null parentId always means "my own drive root" - a grant can only
  // ever target a specific item, never someone else's whole root.
  const allItems = (
    parent ? getState().nodes.filter((n) => n.parentId === parent.id && !n.trashed) : childrenOf(uid, parentId)
  ).sort((a, b) => compareNodes(a, b, sortBy, sortDir));

  const page = allItems.slice(offset, offset + limit);
  const access = parent ? viewerRole(parent, uid) : 'owner';

  res.json({
    items: page.map((n) => serialize(n, uid)),
    breadcrumb: parent ? breadcrumbFor(parent, uid).map((n) => serialize(n, uid)) : [],
    // What the viewer may do in this folder as a whole (new folder, upload,
    // ...) - 'owner' in their own drive, else the level they were granted.
    access,
    ownerUsername: parent && access !== 'owner' ? findUserById(parent.ownerId)?.username || null : null,
    total: allItems.length,
    hasMore: offset + page.length < allItems.length,
  });
});

router.get('/trash', requireAuth, (req, res) => {
  const items = allOwnedBy(req.user.id).filter(isTopLevelTrashed);
  items.sort((a, b) => (b.trashedAt || 0) - (a.trashedAt || 0));
  res.json({ items: items.map((n) => serialize(n, req.user.id)) });
});

router.get('/search', requireAuth, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.json({ items: [] });
  const uid = req.user.id;
  // Your own drive plus everything shared with you - a search shouldn't
  // miss a file just because it lives in someone else's shared folder.
  const candidates = [...allOwnedBy(uid), ...nodesSharedWith(uid, buildChildrenIndex())];
  const items = candidates.filter((n) => {
    if (n.trashed) return false;
    if (n.name.toLowerCase().includes(q)) return true;
    return Boolean(n.contentText && n.contentText.toLowerCase().includes(q));
  });
  // Content-only matches (the query isn't in the name) get flagged so the
  // UI can explain why a result showed up.
  res.json({
    items: items.slice(0, 500).map((n) => ({
      ...serialize(n, uid),
      contentMatch: !n.name.toLowerCase().includes(q) && Boolean(n.contentText),
    })),
  });
});

router.get('/starred', requireAuth, (req, res) => {
  const items = allOwnedBy(req.user.id).filter((n) => n.starred && !n.trashed);
  items.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  res.json({ items: items.map((n) => serialize(n, req.user.id)) });
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
  res.json({ items: items.map((n) => serialize(n, req.user.id)) });
});

// Before an upload starts, tells the client which of the files it's about
// to send would land on a name that's already taken - so it can ask
// "replace, keep both, or skip?" up front. `paths` are the same relative
// paths an upload sends ("Photos/2024/a.jpg", or just "a.jpg"); only
// folders that already exist are followed, since anything inside a folder
// the upload is about to create can't clash with anything.
router.post('/check-conflicts', requireFetchHeader, requireAuth, (req, res) => {
  const parentId = fromClientParentId(req.body?.parentId);
  if (!assertParentIsUsableFolder(req, res, parentId, 'upload')) return;
  const paths = Array.isArray(req.body?.paths) ? req.body.paths.slice(0, 100000) : [];
  const parent = parentId ? findNodeById(parentId) : null;
  const ownerId = parent ? parent.ownerId : req.user.id;

  const byParent = new Map();
  for (const n of getState().nodes) {
    if (n.ownerId !== ownerId || n.trashed) continue;
    const key = n.parentId ?? 'root';
    let names = byParent.get(key);
    if (!names) byParent.set(key, (names = new Map()));
    names.set(n.name.toLowerCase(), n);
  }
  const lookup = (pid, name) => byParent.get(pid ?? 'root')?.get(name.toLowerCase());

  const conflicts = [];
  paths.forEach((rawPath, index) => {
    const segments = String(rawPath || '').split('/').filter(Boolean).map(sanitizeName);
    if (!segments.length) return;
    let pid = parentId;
    for (const folderName of segments.slice(0, -1)) {
      const folder = lookup(pid, folderName);
      if (!folder || folder.type !== 'folder') return;
      pid = folder.id;
    }
    const existing = lookup(pid, segments[segments.length - 1]);
    if (!existing) return;
    conflicts.push({
      index,
      path: rawPath,
      existing: serialize(existing, req.user.id),
    });
  });
  res.json({ conflicts });
});

router.get('/:id', requireAuth, (req, res) => {
  const node = loadAccessibleNode(req, res, 'view');
  if (!node) return;
  res.json({
    item: serialize(node, req.user.id),
    breadcrumb: breadcrumbFor(node, req.user.id).map((n) => serialize(n, req.user.id)),
  });
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
  const name = sanitizeName(rawName);
  if (findSibling(ownerId, parentId, name)) {
    return res.status(409).json({ error: `Something named "${name}" is already in this folder` });
  }
  const state = getState();
  const now = Date.now();
  const node = {
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
  state.nodes.push(node);
  logActivity({ userId: req.user.id, username: req.user.username, action: 'create_folder', targetName: node.name });
  save();
  res.status(201).json({ item: serialize(node, req.user.id) });
});

// Resolves (creating as needed) the chain of subfolders described by
// `segments` under `baseParentId`, reusing folders already created earlier
// in the same upload batch (via `cache`) so a folder with many files isn't
// recreated once per file. An existing folder of the same name is merged
// into, the way copying a folder onto a desktop merges it.
function resolveFolderChain(ownerId, baseParentId, segments, cache) {
  let parentId = baseParentId;
  for (const rawName of segments) {
    const name = sanitizeName(rawName);
    const cacheKey = `${parentId ?? 'root'}\u0000${name.toLowerCase()}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      parentId = cached;
      continue;
    }
    const state = getState();
    const lower = name.toLowerCase();
    let folder = state.nodes.find(
      (n) =>
        n.ownerId === ownerId &&
        n.parentId === parentId &&
        n.type === 'folder' &&
        !n.trashed &&
        n.name.toLowerCase() === lower
    );
    if (!folder) {
      const now = Date.now();
      folder = {
        id: uuid(),
        // A *file* can already hold this name - don't create a second
        // item with the exact same name next to it.
        name: uniqueName(ownerId, parentId, name),
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

  // Restoring out of the trash is the owner's call alone - a collaborator
  // never sees the trash at all.
  if (trashed === false && node.ownerId !== req.user.id) {
    return res.status(404).json({ error: 'Not found' });
  }

  if (typeof name === 'string') {
    const trimmed = name.trim();
    if (!trimmed) return res.status(400).json({ error: 'Name cannot be empty' });
    const newName = sanitizeName(trimmed);
    if (newName !== node.name) {
      if (findSibling(node.ownerId, node.parentId, newName, { excludeId: node.id })) {
        return res.status(409).json({ error: `Something named "${newName}" is already in this folder` });
      }
      logActivity({ ...activityBase, action: 'rename', targetName: node.name, details: `to "${newName}"` });
      node.name = newName;
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
    if (targetParentId !== node.parentId) {
      // Landing on a name that's already taken there keeps both, as
      // "name (1).ext", rather than refusing the move.
      node.name = uniqueName(node.ownerId, targetParentId, node.name);
      node.parentId = targetParentId;
      logActivity({ ...activityBase, action: 'move', targetName: node.name });
      contentChanged = true;
    }
  }

  if (typeof trashed === 'boolean' && trashed !== Boolean(node.trashed)) {
    if (trashed) trashNode(node);
    else {
      restoreNode(node);
      // Its old spot may have been reused by a same-named item meanwhile.
      node.name = uniqueName(node.ownerId, node.parentId, node.name);
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
  res.json({ item: serialize(node, req.user.id) });
});

router.delete('/trash', requireFetchHeader, requireAuth, async (req, res) => {
  const roots = getState().nodes.filter((n) => n.ownerId === req.user.id && isTopLevelTrashed(n));
  const removed = await removeNodesPermanently(roots);
  if (removed) {
    logActivity({
      userId: req.user.id,
      username: req.user.username,
      action: 'empty_trash',
      targetName: `${roots.length} item(s)`,
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
  await removeNodesPermanently([node]);
  logActivity({
    userId: req.user.id,
    username: req.user.username,
    action: 'delete_forever',
    targetName: node.name,
  });
  await save();
  res.json({ ok: true });
});

// Applies link settings from a request body to anything link-shareable (a
// node, whose fields are share-prefixed so they don't collide with its own,
// or a multi-item link, which only ever holds link state). Only fields
// actually present in the body are touched - the client can't safely
// re-send a password it's never given back, so omitting one means "leave
// it as-is" rather than "clear it".
function applyLinkSettings(target, body, fields) {
  const { expiresInMs, password } = body || {};
  if (expiresInMs !== undefined) {
    target[fields.expiresAt] = typeof expiresInMs === 'number' && expiresInMs > 0 ? Date.now() + expiresInMs : null;
  }
  if (password !== undefined) {
    target[fields.passwordHash] = password ? hashPassword(String(password)) : null;
  }
}

router.post('/:id/share', requireFetchHeader, requireAuth, (req, res) => {
  const node = loadOwnedNode(req, res);
  if (!node) return;
  if (node.trashed) return res.status(400).json({ error: "Restore this item from the trash before sharing it" });
  // Keep the existing token (if any) so changing just the expiry/password
  // doesn't invalidate a link already handed out.
  const isNew = !node.shareToken;
  if (isNew) node.shareToken = crypto.randomBytes(24).toString('base64url');
  applyLinkSettings(node, req.body, { expiresAt: 'shareExpiresAt', passwordHash: 'sharePasswordHash' });
  const { uploadEnabled } = req.body || {};
  if (uploadEnabled !== undefined && node.type === 'folder') {
    node.shareUploadEnabled = Boolean(uploadEnabled);
  }
  if (isNew) {
    logActivity({ userId: req.user.id, username: req.user.username, action: 'share', targetName: node.name });
  }
  save();
  res.json({ item: serialize(node, req.user.id), shareToken: node.shareToken });
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
  res.json({ item: serialize(node, req.user.id) });
});

// A multi-item link shares an arbitrary set of files/folders (possibly
// from different parents) behind one token, distinct from the single-item
// link above which always ties a token to exactly one node's subtree.
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
  applyLinkSettings(bundle, req.body, { expiresAt: 'expiresAt', passwordHash: 'passwordHash' });
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

function loadOwnedBundle(req, res) {
  const bundle = findBundleById(req.params.id);
  if (!bundle || bundle.ownerId !== req.user.id) {
    res.status(404).json({ error: 'Not found' });
    return null;
  }
  return bundle;
}

router.get('/share-bundle/:id', requireAuth, (req, res) => {
  const bundle = loadOwnedBundle(req, res);
  if (!bundle) return;
  res.json({ bundle: serializeBundle(bundle) });
});

router.patch('/share-bundle/:id', requireFetchHeader, requireAuth, (req, res) => {
  const bundle = loadOwnedBundle(req, res);
  if (!bundle) return;
  applyLinkSettings(bundle, req.body, { expiresAt: 'expiresAt', passwordHash: 'passwordHash' });
  save();
  res.json({ bundle: serializeBundle(bundle) });
});

router.delete('/share-bundle/:id', requireFetchHeader, requireAuth, (req, res) => {
  const bundle = loadOwnedBundle(req, res);
  if (!bundle) return;
  const state = getState();
  state.bundles = state.bundles.filter((b) => b.id !== bundle.id);
  logActivity({ userId: req.user.id, username: req.user.username, action: 'unshare', targetName: 'multi-item link' });
  save();
  res.json({ ok: true });
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

  const oldThumbnailBlobName = node.thumbnailBlobName;
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
  const thumbnailBlobName = await maybeGenerateThumbnail(version.mimeType, blobPath(version.blobName));
  if (thumbnailBlobName) node.thumbnailBlobName = thumbnailBlobName;
  else delete node.thumbnailBlobName;
  if (oldThumbnailBlobName) await fsp.unlink(blobPath(oldThumbnailBlobName)).catch(() => {});

  logActivity({ userId: req.user.id, username: req.user.username, action: 'restore_version', targetName: node.name });
  await save();
  res.json({ item: serialize(node, req.user.id) });
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
  // The person who wrote a comment can remove it, and so can the item's
  // owner - but "view" access alone is no moderation right over other
  // people's notes.
  if (comment.userId !== req.user.id && node.ownerId !== req.user.id) {
    return res.status(403).json({ error: 'Not your comment' });
  }
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
    if (!match || (!match[1] && !match[2])) {
      res.setHeader('Content-Range', `bytes */${stat.size}`);
      return res.status(416).end();
    }
    let start;
    let end;
    if (!match[1]) {
      // "bytes=-500" is a suffix range: the LAST 500 bytes.
      start = Math.max(0, stat.size - parseInt(match[2], 10));
      end = stat.size - 1;
    } else {
      start = parseInt(match[1], 10);
      // An end past the last byte is clamped, not rejected (RFC 9110).
      end = match[2] ? Math.min(parseInt(match[2], 10), stat.size - 1) : stat.size - 1;
    }
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
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

// Falls back to the original file for anything without a pre-generated
// thumbnail (a non-image, or one uploaded before this feature/that sharp
// couldn't decode) - the client always just requests this URL for a
// listing's row icon, no separate "does this have a thumbnail" check.
router.get('/:id/thumbnail', requireAuth, (req, res) => {
  const node = loadAccessibleNode(req, res, 'view');
  if (!node) return;
  if (node.type !== 'file') return res.status(400).json({ error: 'Not a file' });
  const target = node.thumbnailBlobName
    ? { ...node, blobName: node.thumbnailBlobName, mimeType: 'image/jpeg' }
    : node;
  res.setHeader('Cache-Control', 'private, max-age=86400');
  streamFile(req, res, target);
});

export {
  streamFile,
  maybeGenerateThumbnail,
  assertParentIsUsableFolder,
  resolveFolderChain,
  sanitizeName,
  serialize,
  serializeBundle,
  fromClientParentId,
  loadAccessibleNode,
  isLinkExpired,
};
export default router;
