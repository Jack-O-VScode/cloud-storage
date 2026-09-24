import { getState, findNodeById } from '../store.js';

// Walks parentId pointers up to the root, returning [root, ..., node].
export function breadcrumb(node) {
  const chain = [];
  let cur = node;
  const seen = new Set();
  while (cur) {
    if (seen.has(cur.id)) break; // corrupt data guard
    seen.add(cur.id);
    chain.unshift(cur);
    cur = cur.parentId ? findNodeById(cur.parentId) : null;
  }
  return chain;
}

// True if `candidateAncestorId` is `nodeId` itself or one of its ancestors -
// used to stop a folder being moved inside its own subtree.
export function isSelfOrDescendantMove(nodeId, targetParentId) {
  if (nodeId === targetParentId) return true;
  let cur = targetParentId ? findNodeById(targetParentId) : null;
  const seen = new Set();
  while (cur) {
    if (cur.id === nodeId) return true;
    if (seen.has(cur.id)) break;
    seen.add(cur.id);
    cur = cur.parentId ? findNodeById(cur.parentId) : null;
  }
  return false;
}

// True if `nodeId` is `rootId` itself or nested somewhere under it - used to
// keep a shared folder's public browsing confined to its own subtree.
export function isWithin(nodeId, rootId) {
  if (nodeId === rootId) return true;
  let cur = findNodeById(nodeId);
  const seen = new Set();
  while (cur) {
    if (cur.parentId === rootId) return true;
    if (seen.has(cur.id)) break;
    seen.add(cur.id);
    cur = cur.parentId ? findNodeById(cur.parentId) : null;
  }
  return false;
}

export function descendantsOf(nodeId) {
  const state = getState();
  const result = [];
  const stack = [nodeId];
  while (stack.length) {
    const id = stack.pop();
    for (const n of state.nodes) {
      if (n.parentId === id) {
        result.push(n);
        stack.push(n.id);
      }
    }
  }
  return result;
}
