import { Router } from 'express';
import crypto from 'node:crypto';
import { requireAuth, requireFetchHeader } from '../auth.js';
import {
  getState,
  save,
  findNodeById,
  findUserByUsername,
  findUserById,
  findGrantById,
  findGrant,
  grantsForNode,
  grantsForUser,
  logActivity,
} from '../store.js';
import { LEVELS } from '../lib/access.js';
import { serialize } from './nodes.js';

const router = Router();

function serializeGrant(g) {
  const grantee = findUserById(g.granteeUserId);
  return {
    id: g.id,
    nodeId: g.nodeId,
    granteeUserId: g.granteeUserId,
    granteeUsername: grantee?.username || '(deleted user)',
    permission: g.permission,
    createdAt: g.createdAt,
  };
}

// Only the item's owner can view/manage who it's shared with - sharing
// controls stay owner-only even for a collaborator with edit access.
function loadOwnedNode(req, res, nodeId) {
  const node = findNodeById(nodeId);
  if (!node || node.ownerId !== req.user.id || node.trashed) {
    res.status(404).json({ error: 'Not found' });
    return null;
  }
  return node;
}

function grantsResponse(node) {
  return { grants: grantsForNode(node.id).map(serializeGrant) };
}

router.get('/for-node/:nodeId', requireAuth, (req, res) => {
  const node = loadOwnedNode(req, res, req.params.nodeId);
  if (!node) return;
  res.json(grantsResponse(node));
});

// Adds someone, or changes the level of someone already added.
router.post('/', requireFetchHeader, requireAuth, (req, res) => {
  const { nodeId, granteeUsername, permission } = req.body || {};
  const node = loadOwnedNode(req, res, nodeId);
  if (!node) return;
  if (!Object.prototype.hasOwnProperty.call(LEVELS, permission)) {
    return res.status(400).json({ error: 'Invalid permission level' });
  }
  // "Can upload" means adding new files into a folder - there's nothing
  // to upload into on a single file.
  if (permission === 'upload' && node.type !== 'folder') {
    return res.status(400).json({ error: 'Upload access only applies to folders' });
  }
  const username = String(granteeUsername || '').trim();
  const grantee = username ? findUserByUsername(username) : null;
  if (!grantee) return res.status(404).json({ error: `No account called "${username}"` });
  if (grantee.id === req.user.id) return res.status(400).json({ error: "That's you - you already own this" });

  const state = getState();
  const existing = findGrant(node.id, grantee.id);
  if (existing) {
    existing.permission = permission;
  } else {
    state.grants.push({
      id: crypto.randomUUID(),
      nodeId: node.id,
      ownerId: req.user.id,
      granteeUserId: grantee.id,
      permission,
      createdAt: Date.now(),
    });
  }
  logActivity({
    userId: req.user.id,
    username: req.user.username,
    action: 'grant_access',
    targetName: node.name,
    details: `${permission} access to ${grantee.username}`,
  });
  save();
  res.status(201).json(grantsResponse(node));
});

// The owner can take anyone's access away; a person can also remove
// something shared with them from their own "Shared with me".
router.delete('/:id', requireFetchHeader, requireAuth, (req, res) => {
  const grant = findGrantById(req.params.id);
  const node = grant && findNodeById(grant.nodeId);
  const isOwner = node && node.ownerId === req.user.id;
  const isGrantee = grant && grant.granteeUserId === req.user.id;
  if (!grant || (!isOwner && !isGrantee)) return res.status(404).json({ error: 'Not found' });
  const state = getState();
  state.grants = state.grants.filter((g) => g.id !== grant.id);
  logActivity({
    userId: req.user.id,
    username: req.user.username,
    action: isOwner ? 'revoke_access' : 'leave_share',
    targetName: node?.name || '(deleted item)',
  });
  save();
  res.json(node && isOwner ? grantsResponse(node) : { ok: true });
});

// Items directly shared with the current user (not ones they merely have
// inherited access to via a deeper grant) - the entry points for their
// "Shared with me" view.
router.get('/shared-with-me', requireAuth, (req, res) => {
  const items = grantsForUser(req.user.id)
    .map((g) => {
      const node = findNodeById(g.nodeId);
      if (!node || node.trashed) return null;
      return {
        ...serialize(node, req.user.id),
        grantId: g.id,
        permission: g.permission,
        sharedAt: g.createdAt,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b.sharedAt || 0) - (a.sharedAt || 0));
  res.json({ items });
});

export { serializeGrant };
export default router;
