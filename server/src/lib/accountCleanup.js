import crypto from 'node:crypto';
import { getState, logActivity } from '../store.js';
import { uniqueName } from './names.js';

function clearLinkSharing(node) {
  node.shareToken = null;
  node.shareExpiresAt = null;
  node.sharePasswordHash = null;
  node.shareUploadEnabled = false;
}

// Hands everything `fromUserIds` owned to `toUser`, gathered under one new
// folder at the top of their drive, and drops every piece of sharing that
// involved those accounts - their public links (so nothing of theirs
// stays reachable by link after the account is gone), and people access
// both given by them and given to them.
export function transferOwnedData(fromUserIds, toUser, folderLabel) {
  const state = getState();
  const from = new Set(fromUserIds);
  const theirNodes = state.nodes.filter((n) => from.has(n.ownerId));
  const theirNodeIds = new Set(theirNodes.map((n) => n.id));

  state.grants = state.grants.filter(
    (g) => !from.has(g.granteeUserId) && !from.has(g.ownerId) && !theirNodeIds.has(g.nodeId)
  );
  state.bundles = state.bundles.filter((b) => !from.has(b.ownerId));

  if (!theirNodes.length) return null;
  const now = Date.now();
  const folder = {
    id: crypto.randomUUID(),
    name: uniqueName(toUser.id, null, folderLabel),
    type: 'folder',
    parentId: null,
    ownerId: toUser.id,
    trashed: false,
    trashedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  state.nodes.push(folder);
  for (const n of theirNodes) {
    n.ownerId = toUser.id;
    if (n.parentId === null) n.parentId = folder.id;
    n.starred = false; // stars were the old owner's own bookmarks
    clearLinkSharing(n);
  }
  return folder;
}

// Files left behind by accounts deleted before deletion started
// transferring them are otherwise invisible to everyone while still using
// disk - hand them to the first admin once, at startup.
export function adoptOrphanedData() {
  const state = getState();
  const userIds = new Set(state.users.map((u) => u.id));
  const orphanOwners = [...new Set(state.nodes.filter((n) => !userIds.has(n.ownerId)).map((n) => n.ownerId))];
  const staleGrants = state.grants.some((g) => !userIds.has(g.granteeUserId));
  const staleBundles = state.bundles.some((b) => !userIds.has(b.ownerId));
  if (!orphanOwners.length && !staleGrants && !staleBundles) return false;

  state.grants = state.grants.filter((g) => userIds.has(g.granteeUserId));
  state.bundles = state.bundles.filter((b) => userIds.has(b.ownerId));
  const admin = state.users.find((u) => u.isAdmin);
  if (admin && orphanOwners.length) {
    const folder = transferOwnedData(orphanOwners, admin, 'From deleted accounts');
    if (folder) {
      logActivity({ action: 'adopt_orphans', targetName: folder.name, details: `moved to ${admin.username}` });
    }
  }
  return true;
}
