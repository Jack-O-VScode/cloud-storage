import { getState } from '../store.js';

// Strips path separators/control characters so a file or folder name can
// never be mistaken for a path segment - matters once names feed into zip
// entry paths, not just because it's confusing in the UI.
export function sanitizeName(raw) {
  const cleaned = String(raw || '').replace(/[/\\\u0000-\u001f]/g, ' ').trim();
  return cleaned || 'Untitled';
}

function splitExtension(name) {
  const dot = name.lastIndexOf('.');
  // A leading dot (".env") is part of the name, not an extension.
  if (dot <= 0) return [name, ''];
  return [name.slice(0, dot), name.slice(dot)];
}

// Name comparison is case-insensitive, matching how Windows/macOS (and so
// a mounted WebDAV drive) treat two names differing only in case.
function sameName(a, b) {
  return a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;
}

export function findSibling(ownerId, parentId, name, { excludeId } = {}) {
  return getState().nodes.find(
    (n) => n.ownerId === ownerId && n.parentId === parentId && !n.trashed && n.id !== excludeId && sameName(n.name, name)
  );
}

// "photo.jpg" -> "photo (1).jpg", "photo (2).jpg", ... - the first variant
// not already taken in that folder. Returns `name` itself if it's free.
export function uniqueName(ownerId, parentId, name) {
  if (!findSibling(ownerId, parentId, name)) return name;
  const [base, ext] = splitExtension(name);
  for (let i = 1; i < 10000; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!findSibling(ownerId, parentId, candidate)) return candidate;
  }
  return `${base} (${Date.now()})${ext}`;
}
