import { Router } from 'express';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { getState, findNodeById, findUserById, findBundleByToken } from '../store.js';
import { verifyPassword, requireFetchHeader } from '../auth.js';
import { isWithin, breadcrumb } from '../lib/tree.js';
import { streamZip } from '../lib/zip.js';
import { getSession } from '../lib/uploadSessions.js';
import { streamFile } from './nodes.js';
import {
  startSession,
  writeChunk,
  completeSession,
  cancelSession,
  assertQuota,
  rawChunkBody,
  sendError,
} from './uploadSessions.js';

const router = Router();

// A link password is the only thing between the internet and whatever it
// protects - cap guesses per IP so it can't simply be brute-forced.
const unlockLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Too many wrong passwords - try again in 15 minutes' },
});

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
    updatedAt: node.updatedAt || null,
    hasThumbnail: Boolean(node.thumbnailBlobName),
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

router.post('/:token/unlock', requireFetchHeader, unlockLimiter, (req, res) => {
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

router.get('/:token/thumbnail', (req, res) => {
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
  if (file.type !== 'file' || !file.thumbnailBlobName) return res.status(404).json({ error: 'No thumbnail' });
  res.setHeader('Cache-Control', 'private, max-age=86400');
  streamFile(req, res, { ...file, blobName: file.thumbnailBlobName, mimeType: 'image/jpeg' });
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

// Visitor uploads into a folder the owner explicitly opted in to
// receiving uploads (node.shareUploadEnabled) - a multi-item link never
// supports this, since it has no single folder to receive files into.
// Same resumable, chunked protocol as signed-in uploads, with the link
// itself as the credential; a clashing name is always kept alongside
// ("name (1).ext") - a visitor can never overwrite the owner's files.
function loadUploadableShare(req, res) {
  const node = findByShareToken(req.params.token);
  if (!node || isExpired(node) || node.type !== 'folder' || !node.shareUploadEnabled) {
    res.status(404).json({ error: 'Link not found, revoked, expired, or uploads disabled' });
    return null;
  }
  if (!isUnlocked(req, node)) {
    res.status(401).json({ error: 'Password required' });
    return null;
  }
  return node;
}

function loadShareSession(req, res) {
  const node = loadUploadableShare(req, res);
  if (!node) return null;
  const session = getSession(req.params.sessionId);
  if (!session || session.uploader.shareToken !== node.shareToken) {
    res.status(404).json({ error: 'Upload session not found or expired' });
    return null;
  }
  return { node, session };
}

router.post('/:token/upload-sessions', requireFetchHeader, async (req, res) => {
  const node = loadUploadableShare(req, res);
  if (!node) return;
  const body = req.body || {};
  req.query.nodeId = body.nodeId || undefined;
  const folder = resolveTargetNode(req, res, node);
  if (!folder) return;
  if (folder.type !== 'folder') return res.status(400).json({ error: 'Not a folder' });
  try {
    const size = Number(body.size);
    if (!Number.isInteger(size) || size < 0 || size > config.maxUploadBytes) {
      return res.status(400).json({ error: 'Invalid or missing file size' });
    }
    assertQuota(node.ownerId, size);
    const session = await startSession({
      uploader: { shareToken: node.shareToken },
      ownerId: node.ownerId,
      parentId: folder.id,
      name: body.name,
      mimeType: body.mimeType,
      size,
      onConflict: 'rename',
    });
    res.status(201).json({ sessionId: session.id });
  } catch (err) {
    sendError(res, err);
  }
});

router.put('/:token/upload-sessions/:sessionId/chunk', requireFetchHeader, rawChunkBody, async (req, res) => {
  const loaded = loadShareSession(req, res);
  if (!loaded) return;
  await writeChunk(req, res, loaded.session);
});

router.post('/:token/upload-sessions/:sessionId/complete', requireFetchHeader, async (req, res) => {
  const loaded = loadShareSession(req, res);
  if (!loaded) return;
  try {
    const owner = findUserById(loaded.node.ownerId);
    const { node } = await completeSession(loaded.session, {
      actorName: owner?.username,
      activityAction: 'share_upload',
      activityDetails: `via shared link into "${loaded.node.name}"`,
    });
    res.status(201).json({ item: publicSerialize(node) });
  } catch (err) {
    sendError(res, err);
  }
});

router.delete('/:token/upload-sessions/:sessionId', requireFetchHeader, async (req, res) => {
  const loaded = loadShareSession(req, res);
  if (!loaded) return;
  await cancelSession(loaded.session);
  res.json({ ok: true });
});

export default router;
