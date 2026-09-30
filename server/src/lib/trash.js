import { getState, findNodeById } from '../store.js';
import { descendantsOf, buildChildrenIndex } from './tree.js';
import { purgeNodeBlob } from './purge.js';

// Trashing a folder takes everything inside it along, but records which
// descendants went with it (`trashedWith`) so restoring the folder later
// only brings back what it took - not something that had already been
// trashed on its own before. `trashRoot` marks the item the user actually
// trashed, which is what the Trash view lists.
export function trashNode(node, now = Date.now()) {
  node.trashed = true;
  node.trashedAt = now;
  node.trashRoot = true;
  delete node.trashedWith;
  for (const d of descendantsOf(node.id)) {
    if (d.trashed) continue;
    d.trashed = true;
    d.trashedAt = now;
    d.trashedWith = node.id;
    delete d.trashRoot;
  }
}

export function restoreNode(node) {
  // Restoring into a folder that's itself still in the trash would leave
  // the item invisible (nothing lists a trashed folder's contents) - put it
  // back at the top of its owner's drive instead.
  const parent = node.parentId ? findNodeById(node.parentId) : null;
  if (node.parentId && (!parent || parent.trashed)) node.parentId = null;

  node.trashed = false;
  node.trashedAt = null;
  const markedCascade = Boolean(node.trashRoot);
  delete node.trashRoot;
  delete node.trashedWith;
  for (const d of descendantsOf(node.id)) {
    if (!d.trashed) continue;
    // Items trashed before this bookkeeping existed carry no marker at
    // all - fall back to the old behaviour of restoring the whole subtree.
    if (markedCascade && d.trashedWith !== node.id) continue;
    d.trashed = false;
    d.trashedAt = null;
    delete d.trashedWith;
  }
}

// What the Trash view shows: trashed items whose parent isn't trashed too
// - a trashed folder appears once, not once per file inside it.
export function isTopLevelTrashed(node) {
  if (!node.trashed) return false;
  const parent = node.parentId ? findNodeById(node.parentId) : null;
  return !parent || !parent.trashed;
}

// Permanently removes `roots` and everything beneath them: blobs on disk,
// the nodes themselves, and any sharing that pointed at them (people
// grants, and multi-item links - a link left with nothing in it is
// dropped entirely).
export async function removeNodesPermanently(roots) {
  const state = getState();
  const childrenIndex = buildChildrenIndex();
  const removeIds = new Set();
  const toRemove = [];
  for (const root of roots) {
    for (const n of [root, ...descendantsOf(root.id, childrenIndex)]) {
      if (removeIds.has(n.id)) continue;
      removeIds.add(n.id);
      toRemove.push(n);
    }
  }
  if (!toRemove.length) return 0;
  await Promise.all(toRemove.map((n) => purgeNodeBlob(n)));
  state.nodes = state.nodes.filter((n) => !removeIds.has(n.id));
  state.grants = state.grants.filter((g) => !removeIds.has(g.nodeId));
  for (const b of state.bundles) b.nodeIds = b.nodeIds.filter((id) => !removeIds.has(id));
  state.bundles = state.bundles.filter((b) => b.nodeIds.length > 0);
  return toRemove.length;
}
