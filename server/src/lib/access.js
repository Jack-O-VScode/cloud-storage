import { getState, findNodeById } from '../store.js';
import { breadcrumb } from './tree.js';

// A grant lives on a folder and extends to everything inside it, same as a
// real filesystem ACL - so access to a node is "does any ancestor folder
// (or the node itself) carry a grant for this user", taking the highest
// level found along the way.
export const LEVELS = { view: 0, upload: 1, edit: 2 };

export function accessLevel(node, userId) {
  if (!node) return null;
  if (node.ownerId === userId) return 'edit';
  const grants = getState().grants;
  let best = -1;
  let cur = node;
  const seen = new Set();
  while (cur) {
    if (seen.has(cur.id)) break;
    seen.add(cur.id);
    const grant = grants.find((g) => g.folderId === cur.id && g.granteeUserId === userId);
    if (grant) best = Math.max(best, LEVELS[grant.permission]);
    cur = cur.parentId ? findNodeById(cur.parentId) : null;
  }
  if (best === -1) return null;
  return Object.keys(LEVELS).find((k) => LEVELS[k] === best);
}

export function hasAccess(node, userId, required) {
  const level = accessLevel(node, userId);
  return level !== null && LEVELS[level] >= LEVELS[required];
}

// Index into breadcrumb(node) (root-to-node order) of the outermost
// ancestor carrying a DIRECT grant for userId - the folder they were
// actually invited into. Browsing/breadcrumbs are truncated to start
// there, so a collaborator's view never reveals the owner's folder
// structure above the folder shared with them.
export function shareRootIndex(node, userId) {
  const chain = breadcrumb(node);
  const grants = getState().grants;
  for (let i = 0; i < chain.length; i++) {
    if (grants.some((g) => g.folderId === chain[i].id && g.granteeUserId === userId)) return i;
  }
  return -1;
}

// The breadcrumb to show a given viewer for `node` - their own full chain
// if they own it, or the truncated chain starting at their share root.
export function breadcrumbFor(node, userId) {
  const chain = breadcrumb(node);
  if (node.ownerId === userId) return chain;
  const idx = Math.max(0, shareRootIndex(node, userId));
  return chain.slice(idx);
}
