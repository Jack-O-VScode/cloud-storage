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
  grantsForFolder,
  grantsForUser,
  logActivity,
} from '../store.js';
import { LEVELS } from '../lib/access.js';

const router = Router();

function serializeGrant(g) {
  const grantee = findUserById(g.granteeUserId);
  return {
    id: g.id,
    folderId: g.folderId,
    granteeUserId: g.granteeUserId,
    granteeUsername: grantee?.username || '(deleted user)',
    permission: g.permission,
    createdAt: g.createdAt,
  };
}

// Only the folder's owner can view/manage who it's shared with - sharing
// controls stay owner-only even for a collaborator with edit access.
function loadOwnedFolder(req, res, folderId) {
  const folder = findNodeById(folderId);
  if (!folder || folder.ownerId !== req.user.id || folder.type !== 'folder' || folder.trashed) {
    res.status(404).json({ error: 'Not found' });
    return null;
  }
  return folder;
}

router.get('/for-folder/:folderId', requireAuth, (req, res) => {
  const folder = loadOwnedFolder(req, res, req.params.folderId);
  if (!folder) return;
  res.json({ grants: grantsForFolder(folder.id).map(serializeGrant) });
});

router.post('/', requireFetchHeader, requireAuth, (req, res) => {
  const { folderId, granteeUsername, permission } = req.body || {};
  const folder = loadOwnedFolder(req, res, folderId);
  if (!folder) return;
  if (!Object.prototype.hasOwnProperty.call(LEVELS, permission)) {
    return res.status(400).json({ error: 'Invalid permission level' });
  }
  const username = String(granteeUsername || '').trim();
  const grantee = username ? findUserByUsername(username) : null;
  if (!grantee) return res.status(404).json({ error: 'No account with that username' });
  if (grantee.id === req.user.id) return res.status(400).json({ error: "You already own this folder" });

  const state = getState();
  const existing = findGrant(folder.id, grantee.id);
  if (existing) {
    existing.permission = permission;
  } else {
    state.grants.push({
      id: crypto.randomUUID(),
      folderId: folder.id,
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
    targetName: folder.name,
    details: `${permission} access to ${grantee.username}`,
  });
  save();
  res.status(201).json({ grants: grantsForFolder(folder.id).map(serializeGrant) });
});

router.delete('/:id', requireFetchHeader, requireAuth, (req, res) => {
  const grant = findGrantById(req.params.id);
  if (!grant) return res.status(404).json({ error: 'Not found' });
  const folder = loadOwnedFolder(req, res, grant.folderId);
  if (!folder) return;
  const state = getState();
  state.grants = state.grants.filter((g) => g.id !== grant.id);
  logActivity({ userId: req.user.id, username: req.user.username, action: 'revoke_access', targetName: folder.name });
  save();
  res.json({ grants: grantsForFolder(folder.id).map(serializeGrant) });
});

// Folders directly shared with the current user (not ones they merely have
// inherited access to via a deeper grant) - the entry points for their
// "Shared with me" view.
router.get('/shared-with-me', requireAuth, (req, res) => {
  const items = grantsForUser(req.user.id)
    .map((g) => {
      const folder = findNodeById(g.folderId);
      if (!folder || folder.trashed) return null;
      const owner = findUserById(folder.ownerId);
      return {
        id: folder.id,
        name: folder.name,
        permission: g.permission,
        ownerUsername: owner?.username || '(unknown)',
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  res.json({ items });
});

export default router;
