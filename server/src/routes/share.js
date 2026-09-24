import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { getState, findNodeById } from '../store.js';
import { verifyPassword, requireFetchHeader } from '../auth.js';
import { isWithin, breadcrumb } from '../lib/tree.js';
import { streamZip } from '../lib/zip.js';
import { streamFile } from './nodes.js';

const router = Router();

function findByShareToken(token) {
  return getState().nodes.find((n) => n.shareToken === token && !n.trashed);
}

function isExpired(node) {
  return Boolean(node.shareExpiresAt) && Date.now() > node.shareExpiresAt;
}

// Cookie is scoped per-token (not just "logged into this share") so
// unlocking one shared link never grants access to another.
function shareCookieName(token) {
  return `sa_${token.slice(0, 16)}`;
}

function isUnlocked(req, node) {
  if (!node.sharePasswordHash) return true;
  const cookieVal = req.cookies?.[shareCookieName(node.shareToken)];
  if (!cookieVal) return false;
  try {
    const payload = jwt.verify(cookieVal, config.jwtSecret);
    return payload.sub === node.shareToken;
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

function loadShareNode(req, res) {
  const node = findByShareToken(req.params.token);
  if (!node || isExpired(node)) {
    res.status(404).json({ error: 'Link not found, revoked, or expired' });
    return null;
  }
  return node;
}

// Resolves the item the caller wants (via ?nodeId=) within a share, making
// sure it's the shared node itself or one of its descendants - a share
// token only ever grants access to that one subtree, never the owner's
// whole drive.
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

// Deliberately unauthenticated: this is the public link. Anyone holding the
// token can view/download (after a password check, if one is set), same
// trust model as Drive's "anyone with the link".
router.get('/:token', (req, res) => {
  const node = loadShareNode(req, res);
  if (!node) return;
  res.json({
    item: publicSerialize(node),
    passwordRequired: Boolean(node.sharePasswordHash) && !isUnlocked(req, node),
  });
});

router.post('/:token/unlock', requireFetchHeader, (req, res) => {
  const node = loadShareNode(req, res);
  if (!node) return;
  if (!node.sharePasswordHash) return res.json({ ok: true });
  const { password } = req.body || {};
  if (!password || !verifyPassword(password, node.sharePasswordHash)) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  const token = jwt.sign({ sub: node.shareToken }, config.jwtSecret, { expiresIn: '2h' });
  res.cookie(shareCookieName(node.shareToken), token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd && config.forceHttps,
    maxAge: 2 * 60 * 60 * 1000,
    path: '/',
  });
  res.json({ ok: true });
});

router.get('/:token/list', (req, res) => {
  const node = loadShareNode(req, res);
  if (!node) return;
  if (!isUnlocked(req, node)) return res.status(401).json({ error: 'Password required' });
  const target = resolveTargetNode(req, res, node);
  if (!target) return;
  if (target.type !== 'folder') return res.status(400).json({ error: 'Not a folder' });

  const items = getState()
    .nodes.filter((n) => n.parentId === target.id && n.ownerId === node.ownerId && !n.trashed)
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

  // Breadcrumb relative to the share root - visitors never see anything
  // above the folder that was actually shared.
  const fullChain = breadcrumb(target);
  const rootIndex = fullChain.findIndex((n) => n.id === node.id);
  const relativeChain = rootIndex >= 0 ? fullChain.slice(rootIndex) : [node];

  res.json({ items: items.map(publicSerialize), breadcrumb: relativeChain.map(publicSerialize) });
});

router.get('/:token/download', (req, res) => {
  const node = loadShareNode(req, res);
  if (!node) return;
  if (!isUnlocked(req, node)) return res.status(401).json({ error: 'Password required' });
  const target = resolveTargetNode(req, res, node);
  if (!target) return;
  if (target.type !== 'file') return res.status(400).json({ error: 'Not a file' });
  streamFile(req, res, target);
});

router.get('/:token/zip', async (req, res) => {
  const node = loadShareNode(req, res);
  if (!node) return;
  if (!isUnlocked(req, node)) return res.status(401).json({ error: 'Password required' });
  const target = resolveTargetNode(req, res, node);
  if (!target) return;
  await streamZip(res, [target], `${target.name}.zip`);
});

export default router;
