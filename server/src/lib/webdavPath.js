import { childrenOf } from '../store.js';

export function parsePathSegments(urlPath) {
  return decodeURIComponent(urlPath)
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean);
}

// Resolves a segments array (already parsed, decoded) to the node it names
// within `ownerId`'s own drive, or null if any segment along the way
// doesn't exist. Never touches the filesystem with these names - blobs are
// always addressed by opaque uuid, so there's no path-traversal surface
// here the way a WebDAV server backed by real directories would have.
export function resolveNode(ownerId, segments) {
  let parentId = null;
  let node = null;
  for (let i = 0; i < segments.length; i++) {
    const candidates = childrenOf(ownerId, parentId).filter((n) => n.name === segments[i]);
    node = candidates[0];
    if (!node) return null;
    if (i < segments.length - 1 && node.type !== 'folder') return null;
    parentId = node.id;
  }
  return node;
}

// Resolves the parent folder id (client convention: null = root) for a
// resource's own segments. `undefined` means the parent path itself
// doesn't exist - distinct from `null`, which validly means "drive root".
export function resolveParentId(ownerId, segments) {
  if (segments.length === 0) return undefined;
  if (segments.length === 1) return null;
  const parent = resolveNode(ownerId, segments.slice(0, -1));
  return parent ? parent.id : undefined;
}
