import { Router } from 'express';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import multer from 'multer';
import mime from 'mime-types';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { getState, save, findNodeById, findUserById, allOwnedBy, logActivity, findBundleByToken } from '../store.js';
import { verifyPassword, requireFetchHeader } from '../auth.js';
import { isWithin, breadcrumb } from '../lib/tree.js';
import { streamZip } from '../lib/zip.js';
import { blobPath } from '../lib/paths.js';
import { extractText } from '../lib/textExtract.js';
import { streamFile, maybeGenerateThumbnail } from './nodes.js';

const router = Router();

function findByShareToken(token) {
  return getState().nodes.find((n) => n.shareToken === token && !n.trashed);
}

// Works for both a single-node share and a bundle share - the two fields
// each shape stores its expiry/password under are named differently
// (share-prefixed on a node, so as not to collide with the node's own
// other fields; plain on a bundle, which only ever holds share state).
function getExpiresAt(shareable) {
  return shareable.shareExpiresAt ?? shareable.expiresAt ?? null;
}
function getPasswordHash(shareable) {
  return shareable.sharePasswordHash || shareable.passwordHash || null;
}
function getToken(shareable) {
  return shareable.shareToken || shareable.token;
}

function isExpired(shareable) {
  const expiresAt = getExpiresAt(shareable);
  return Boolean(expiresAt) && Date.now() > expiresAt;
}

// Cookie is scoped per-token (not just "logged into this share") so
// unlocking one shared link never grants access to another.
function shareCookieName(token) {
  return `sa_${token.slice(0, 16)}`;
}

function isUnlocked(req, shareable) {
  const passwordHash = getPasswordHash(shareable);
  if (!passwordHash) return true;
  const token = getToken(shareable);
  const cookieVal = req.cookies?.[shareCookieName(token)];
  if (!cookieVal) return false;
  try {
    const payload = jwt.verify(cookieVal, config.jwtSecret);
    return payload.sub === token;
  } catch {
    return false;
  }
}

function publicSerialize(node) {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    size: node.size || 0,
    mimeType: node.mimeType || null,
  };
}

function sortNodes(nodes) {
  return [...nodes].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

// Resolves which share this token refers to - a single node's subtree, or
// a bundle of arbitrary items - or responds 404 and returns null.
function loadShareTarget(req, res) {
  const node = findByShareToken(req.params.token);
  if (node) {
    if (isExpired(node)) {
      res.status(404).json({ error: 'Link not found, revoked, or expired' });
      return null;
    }
    return { kind: 'node', node };
  }
  const bundle = findBundleByToken(req.params.token);
  if (bundle && !isExpired(bundle)) return { kind: 'bundle', bundle };
  res.status(404).json({ error: 'Link not found, revoked, or expired' });
  return null;
}

// Resolves the item the caller wants (via ?nodeId=) within a single-node
// share, making sure it's the shared node itself or one of its descendants
// - a share token only ever grants access to that one subtree, never the
// owner's whole drive.
function resolveTargetNode(req, res, rootNode) {
  const nodeId = req.query.nodeId;
  if (!nodeId || nodeId === rootNode.id) return rootNode;
  const target = findNodeById(nodeId);
  if (
    !target ||
    target.ownerId !== rootNode.ownerId ||
    target.trashed ||
    !isWithin(target.id, rootNode.id)
  ) {
    res.status(404).json({ error: 'Not found' });
    return null;
  }
  return target;
}

// Same idea for a bundle, whose "root" is a set of nodes rather than one -
// `null` nodeId means "the bundle's own top-level listing", represented by
// `{ root: true }`.
function resolveBundleTarget(req, res, bundle) {
  const nodeId = req.query.nodeId;
  if (!nodeId) return { root: true };
  const target = findNodeById(nodeId);
  const withinBundle = target && bundle.nodeIds.some((id) => id === target.id || isWithin(target.id, id));
  if (!target || target.trashed || !withinBundle) {
    res.status(404).json({ error: 'Not found' });
    return null;
  }
  return { node: target };
}

// Deliberately unauthenticated: this is the public link. Anyone holding the
// token can view/download (after a password check, if one is set), same
// trust model as Drive's "anyone with the link".
router.get('/:token', (req, res) => {
  const target = loadShareTarget(req, res);
  if (!target) return;

  if (target.kind === 'node') {
    const { node } = target;
    return res.json({
      item: publicSerialize(node),
      passwordRequired: Boolean(node.sharePasswordHash) && !isUnlocked(req, node),
      uploadEnabled: node.type === 'folder' && Boolean(node.shareUploadEnabled),
    });
  }

  const { bundle } = target;
  const items = bundle.nodeIds.map((id) => findNodeById(id)).filter((n) => n && !n.trashed);
  res.json({
    bundle: true,
    items: sortNodes(items).map(publicSerialize),
    passwordRequired: Boolean(bundle.passwordHash) && !isUnlocked(req, bundle),
  });
});

router.post('/:token/unlock', requireFetchHeader, (req, res) => {
  const target = loadShareTarget(req, res);
  if (!target) return;
  const shareable = target.kind === 'node' ? target.node : target.bundle;
  const passwordHash = getPasswordHash(shareable);
  if (!passwordHash) return res.json({ ok: true });
  const { password } = req.body || {};
  if (!password || !verifyPassword(password, passwordHash)) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  const token = getToken(shareable);
  const jwtToken = jwt.sign({ sub: token }, config.jwtSecret, { expiresIn: '2h' });
  res.cookie(shareCookieName(token), jwtToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd && config.forceHttps,
    maxAge: 2 * 60 * 60 * 1000,
    path: '/',
  });
  res.json({ ok: true });
});

router.get('/:token/list', (req, res) => {
  const target = loadShareTarget(req, res);
  if (!target) return;
  const shareable = target.kind === 'node' ? target.node : target.bundle;
  if (!isUnlocked(req, shareable)) return res.status(401).json({ error: 'Password required' });

  if (target.kind === 'node') {
    const { node } = target;
    const folder = resolveTargetNode(req, res, node);
    if (!folder) return;
    if (folder.type !== 'folder') return res.status(400).json({ error: 'Not a folder' });

    const items = getState().nodes.filter((n) => n.parentId === folder.id && n.ownerId === node.ownerId && !n.trashed);

    // Breadcrumb relative to the share root - visitors never see anything
    // above the folder that was actually shared.
    const fullChain = breadcrumb(folder);
    const rootIndex = fullChain.findIndex((n) => n.id === node.id);
    const relativeChain = rootIndex >= 0 ? fullChain.slice(rootIndex) : [node];
    return res.json({ items: sortNodes(items).map(publicSerialize), breadcrumb: relativeChain.map(publicSerialize) });
  }

  const { bundle } = target;
  const resolved = resolveBundleTarget(req, res, bundle);
  if (!resolved) return;

  if (resolved.root) {
    const items = bundle.nodeIds.map((id) => findNodeById(id)).filter((n) => n && !n.trashed);
    return res.json({ items: sortNodes(items).map(publicSerialize), breadcrumb: [] });
  }

  const folder = resolved.node;
  if (folder.type !== 'folder') return res.status(400).json({ error: 'Not a folder' });
  const items = getState().nodes.filter((n) => n.parentId === folder.id && n.ownerId === folder.ownerId && !n.trashed);

  // Breadcrumb relative to whichever of the bundle's own items contains
  // this folder, since a bundle has no single shared root of its own.
  const rootId = bundle.nodeIds.find((id) => id === folder.id || isWithin(folder.id, id));
  const rootNode = findNodeById(rootId);
  const fullChain = breadcrumb(folder);
  const rootIndex = fullChain.findIndex((n) => n.id === rootNode.id);
  const relativeChain = rootIndex >= 0 ? fullChain.slice(rootIndex) : [rootNode];
  res.json({ items: sortNodes(items).map(publicSerialize), breadcrumb: relativeChain.map(publicSerialize) });
});

router.get('/:token/download', (req, res) => {
  const target = loadShareTarget(req, res);
  if (!target) return;
  const shareable = target.kind === 'node' ? target.node : target.bundle;
  if (!isUnlocked(req, shareable)) return res.status(401).json({ error: 'Password required' });

  let file;
  if (target.kind === 'node') {
    file = resolveTargetNode(req, res, target.node);
    if (!file) return;
  } else {
    const resolved = resolveBundleTarget(req, res, target.bundle);
    if (!resolved) return;
    if (resolved.root) return res.status(400).json({ error: 'Not a file' });
    file = resolved.node;
  }
  if (file.type !== 'file') return res.status(400).json({ error: 'Not a file' });
  streamFile(req, res, file);
});

router.get('/:token/zip', async (req, res) => {
  const target = loadShareTarget(req, res);
  if (!target) return;
  const shareable = target.kind === 'node' ? target.node : target.bundle;
  if (!isUnlocked(req, shareable)) return res.status(401).json({ error: 'Password required' });

  if (target.kind === 'node') {
    const folder = resolveTargetNode(req, res, target.node);
    if (!folder) return;
    return streamZip(res, [folder], `${folder.name}.zip`);
  }

  const resolved = resolveBundleTarget(req, res, target.bundle);
  if (!resolved) return;
  if (resolved.root) {
    const roots = target.bundle.nodeIds.map((id) => findNodeById(id)).filter((n) => n && !n.trashed);
    return streamZip(res, roots, 'shared-files.zip');
  }
  await streamZip(res, [resolved.node], `${resolved.node.name}.zip`);
});

// Strips path separators/control characters so a file name can never be
// mistaken for a path segment - matters once names feed into zip entries.
function sanitizeName(raw) {
  const cleaned = String(raw || '').replace(/[/\\\u0000-\u001f]/g, ' ').trim();
  return cleaned || 'Untitled';
}

const shareUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.blobDir),
    filename: (req, file, cb) => cb(null, crypto.randomUUID()),
  }),
  limits: { fileSize: config.maxUploadBytes },
});

// Lets visitors upload into a folder the owner explicitly opted in to
// receiving uploads (node.shareUploadEnabled) - a bundle share never
// supports this, since it has no single folder to receive files into.
router.post('/:token/upload', requireFetchHeader, shareUpload.array('files'), async (req, res) => {
  const cleanup = () => Promise.all((req.files || []).map((f) => fsp.unlink(f.path).catch(() => {})));

  const node = findByShareToken(req.params.token);
  if (!node || isExpired(node) || node.type !== 'folder' || !node.shareUploadEnabled) {
    await cleanup();
    return res.status(404).json({ error: 'Link not found, revoked, expired, or uploads disabled' });
  }
  if (!isUnlocked(req, node)) {
    await cleanup();
    return res.status(401).json({ error: 'Password required' });
  }
  const folder = resolveTargetNode(req, res, node);
  if (!folder) {
    await cleanup();
    return;
  }
  if (folder.type !== 'folder') {
    await cleanup();
    return res.status(400).json({ error: 'Not a folder' });
  }

  const owner = findUserById(node.ownerId);
  if (owner?.quotaBytes) {
    const incomingBytes = (req.files || []).reduce((sum, f) => sum + f.size, 0);
    const currentlyUsed = allOwnedBy(node.ownerId)
      .filter((n) => n.type === 'file' && !n.trashed)
      .reduce((sum, n) => sum + (n.size || 0), 0);
    if (currentlyUsed + incomingBytes > owner.quotaBytes) {
      await cleanup();
      return res.status(413).json({ error: "This upload would exceed the folder owner's storage quota." });
    }
  }

  const state = getState();
  const now = Date.now();
  const created = [];
  for (const file of req.files || []) {
    const name = sanitizeName(file.originalname);
    const mimeType = file.mimetype || mime.lookup(file.originalname) || 'application/octet-stream';
    const created_ = {
      id: crypto.randomUUID(),
      name,
      type: 'file',
      parentId: folder.id,
      ownerId: node.ownerId,
      size: file.size,
      mimeType,
      blobName: file.filename,
      trashed: false,
      trashedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const contentText = await extractText(blobPath(file.filename), { mimeType, name, size: file.size });
    if (contentText) created_.contentText = contentText;
    const thumbnailBlobName = await maybeGenerateThumbnail(mimeType, blobPath(file.filename));
    if (thumbnailBlobName) created_.thumbnailBlobName = thumbnailBlobName;
    state.nodes.push(created_);
    created.push(created_);
  }

  if (created.length) {
    logActivity({
      userId: node.ownerId,
      username: owner?.username,
      action: 'share_upload',
      targetName: created.length === 1 ? created[0].name : `${created.length} files`,
      details: `via shared link into "${folder.name}"`,
    });
  }
  await save();
  res.status(201).json({ items: created.map(publicSerialize) });
});

export default router;
