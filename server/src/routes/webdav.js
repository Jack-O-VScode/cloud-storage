import { Router } from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import mime from 'mime-types';
import { config } from '../config.js';
import {
  getState,
  save,
  findUserByUsername,
  findUserById,
  findNodeById,
  childrenOf,
  allOwnedBy,
  logActivity,
} from '../store.js';
import { verifyPassword } from '../auth.js';
import { blobPath } from '../lib/paths.js';
import { isSelfOrDescendantMove, descendantsOf } from '../lib/tree.js';
import { extractText } from '../lib/textExtract.js';
import { parsePathSegments, resolveNode, resolveParentId } from '../lib/webdavPath.js';
import { multistatus, nodePropResponse, lockResponse } from '../lib/webdavXml.js';
import { maybeGenerateThumbnail, sanitizeName } from './nodes.js';

const router = Router();

// WebDAV clients (Explorer's "Map network drive", Finder's "Connect to
// Server", rclone, Cyberduck, ...) authenticate with HTTP Basic Auth on
// every request rather than a session cookie - this only carries real
// protection over HTTPS, same as any Basic Auth endpoint.
function requireBasicAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const match = /^Basic\s+(.+)$/i.exec(header);
  const challenge = () => {
    res.setHeader('WWW-Authenticate', 'Basic realm="Cloud Storage"');
    return res.status(401).send('Authentication required');
  };
  if (!match) return challenge();

  let decoded;
  try {
    decoded = Buffer.from(match[1], 'base64').toString('utf-8');
  } catch {
    return res.status(400).send('Malformed Authorization header');
  }
  const sep = decoded.indexOf(':');
  if (sep === -1) return challenge();
  const username = decoded.slice(0, sep);
  const password = decoded.slice(sep + 1);
  const user = findUserByUsername(username);
  if (!user || !verifyPassword(password, user.passwordHash)) return challenge();

  req.user = user;
  next();
}

router.use(requireBasicAuth);
router.use((req, res, next) => {
  res.setHeader('DAV', '1, 2');
  res.setHeader('MS-Author-Via', 'DAV');
  next();
});

// PROPFIND/LOCK requests often carry an XML body this server ignores (see
// the handlers below) - it still has to be drained so the client isn't
// left waiting on a request the server never finished reading.
router.use((req, res, next) => {
  if (req.method !== 'PROPFIND' && req.method !== 'LOCK') return next();
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', next);
  req.on('error', next);
});

function segmentsFromReq(req) {
  return parsePathSegments(req.path);
}

function hrefFor(segments, isCollection) {
  const path = '/webdav/' + segments.map(encodeURIComponent).join('/');
  return isCollection && !path.endsWith('/') ? path + '/' : path;
}

router.options('*', (req, res) => {
  res.setHeader('Allow', 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, COPY, MOVE, LOCK, UNLOCK');
  res.status(200).end();
});

router.propfind('*', (req, res) => {
  const segments = segmentsFromReq(req);
  const ownerId = req.user.id;
  const node = segments.length ? resolveNode(ownerId, segments) : { type: 'folder', name: '', updatedAt: Date.now() };
  if (!node) return res.status(404).send('Not found');
  if (segments.length && node.type !== 'folder') {
    // A file: PROPFIND just describes itself, Depth is irrelevant.
    return res
      .status(207)
      .type('application/xml; charset=utf-8')
      .send(multistatus([nodePropResponse(node, hrefFor(segments, false))]));
  }

  const entries = [nodePropResponse(node, hrefFor(segments, true))];
  const depth = req.headers.depth;
  if (depth !== '0') {
    const parentId = segments.length ? node.id : null;
    const children = childrenOf(ownerId, parentId).filter((n) => !n.trashed);
    for (const child of children) {
      entries.push(nodePropResponse(child, hrefFor([...segments, child.name], child.type === 'folder')));
    }
  }
  res.status(207).type('application/xml; charset=utf-8').send(multistatus(entries));
});

router.get('*', (req, res) => {
  const segments = segmentsFromReq(req);
  const node = resolveNode(req.user.id, segments);
  if (!node || node.type !== 'file') return res.status(404).send('Not found');
  fs.stat(blobPath(node.blobName), (err, stat) => {
    if (err) return res.status(404).send('File missing on disk');
    res.setHeader('Content-Type', node.mimeType || 'application/octet-stream');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Last-Modified', new Date(node.updatedAt || node.createdAt).toUTCString());
    fs.createReadStream(blobPath(node.blobName)).pipe(res);
  });
});

router.head('*', (req, res) => {
  const segments = segmentsFromReq(req);
  const node = resolveNode(req.user.id, segments);
  if (!node || node.type !== 'file') return res.status(404).end();
  fs.stat(blobPath(node.blobName), (err, stat) => {
    if (err) return res.status(404).end();
    res.setHeader('Content-Type', node.mimeType || 'application/octet-stream');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Last-Modified', new Date(node.updatedAt || node.createdAt).toUTCString());
    res.status(200).end();
  });
});

router.put('*', async (req, res) => {
  const segments = segmentsFromReq(req);
  if (!segments.length) return res.status(405).send('Cannot PUT to the root');
  const ownerId = req.user.id;
  const owner = findUserById(ownerId);
  const parentId = resolveParentId(ownerId, segments);
  if (parentId === undefined) return res.status(409).send('Parent folder does not exist');
  const name = sanitizeName(segments[segments.length - 1]);

  const existing = resolveNode(ownerId, segments);
  if (existing && existing.type === 'folder') return res.status(409).send('A folder already exists at that path');

  const blobName = crypto.randomUUID();
  const dest = fs.createWriteStream(blobPath(blobName));
  try {
    await new Promise((resolve, reject) => {
      req.pipe(dest);
      dest.on('finish', resolve);
      dest.on('error', reject);
      req.on('error', reject);
    });
  } catch {
    await fsp.unlink(blobPath(blobName)).catch(() => {});
    return res.status(500).send('Upload failed');
  }

  const stat = await fsp.stat(blobPath(blobName));
  if (owner?.quotaBytes) {
    const currentlyUsed = allOwnedBy(ownerId)
      .filter((n) => n.type === 'file' && !n.trashed && n.id !== existing?.id)
      .reduce((sum, n) => sum + (n.size || 0), 0);
    if (currentlyUsed + stat.size > owner.quotaBytes) {
      await fsp.unlink(blobPath(blobName)).catch(() => {});
      return res.status(413).send('Storage quota exceeded');
    }
  }

  const mimeType = mime.lookup(name) || 'application/octet-stream';
  const now = Date.now();
  const state = getState();

  if (existing) {
    // Overwriting an existing file - old blob/thumbnail are replaced, not
    // kept as a version; WebDAV clients expect PUT to just replace content.
    const oldBlobName = existing.blobName;
    const oldThumbnailBlobName = existing.thumbnailBlobName;
    existing.blobName = blobName;
    existing.size = stat.size;
    existing.mimeType = mimeType;
    existing.updatedAt = now;
    const contentText = await extractText(blobPath(blobName), { mimeType, name, size: stat.size });
    if (contentText) existing.contentText = contentText;
    else delete existing.contentText;
    const thumbnailBlobName = await maybeGenerateThumbnail(mimeType, blobPath(blobName));
    if (thumbnailBlobName) existing.thumbnailBlobName = thumbnailBlobName;
    else delete existing.thumbnailBlobName;
    if (oldBlobName) await fsp.unlink(blobPath(oldBlobName)).catch(() => {});
    if (oldThumbnailBlobName) await fsp.unlink(blobPath(oldThumbnailBlobName)).catch(() => {});
    logActivity({ userId: ownerId, username: req.user.username, action: 'upload', targetName: name, details: 'via WebDAV' });
    await save();
    return res.status(204).end();
  }

  const node = {
    id: crypto.randomUUID(),
    name,
    type: 'file',
    parentId,
    ownerId,
    size: stat.size,
    mimeType,
    blobName,
    trashed: false,
    trashedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const contentText = await extractText(blobPath(blobName), { mimeType, name, size: stat.size });
  if (contentText) node.contentText = contentText;
  const thumbnailBlobName = await maybeGenerateThumbnail(mimeType, blobPath(blobName));
  if (thumbnailBlobName) node.thumbnailBlobName = thumbnailBlobName;
  state.nodes.push(node);
  logActivity({ userId: ownerId, username: req.user.username, action: 'upload', targetName: name, details: 'via WebDAV' });
  await save();
  res.status(201).end();
});

router.mkcol('*', async (req, res) => {
  const segments = segmentsFromReq(req);
  if (!segments.length) return res.status(405).send('Cannot MKCOL at the root');
  const ownerId = req.user.id;
  const parentId = resolveParentId(ownerId, segments);
  if (parentId === undefined) return res.status(409).send('Parent folder does not exist');
  if (resolveNode(ownerId, segments)) return res.status(405).send('Already exists');

  const now = Date.now();
  const node = {
    id: crypto.randomUUID(),
    name: sanitizeName(segments[segments.length - 1]),
    type: 'folder',
    parentId,
    ownerId,
    trashed: false,
    trashedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  getState().nodes.push(node);
  logActivity({ userId: ownerId, username: req.user.username, action: 'create_folder', targetName: node.name, details: 'via WebDAV' });
  await save();
  res.status(201).end();
});

router.delete('*', async (req, res) => {
  const segments = segmentsFromReq(req);
  if (!segments.length) return res.status(403).send('Cannot delete the root');
  const ownerId = req.user.id;
  const node = resolveNode(ownerId, segments);
  if (!node) return res.status(404).send('Not found');

  // Soft-delete (same as the regular app's trash), not an immediate purge -
  // recoverable from Trash rather than a WebDAV client being able to
  // silently cause unrecoverable data loss.
  const now = Date.now();
  node.trashed = true;
  node.trashedAt = now;
  for (const d of descendantsOf(node.id)) {
    d.trashed = true;
    d.trashedAt = now;
  }
  logActivity({ userId: ownerId, username: req.user.username, action: 'trash', targetName: node.name, details: 'via WebDAV' });
  await save();
  res.status(204).end();
});

function parseDestinationSegments(req) {
  const dest = req.headers.destination;
  if (!dest) return null;
  try {
    const url = new URL(dest, `http://${req.headers.host}`);
    const marker = '/webdav';
    const idx = url.pathname.indexOf(marker);
    return parsePathSegments(idx === -1 ? url.pathname : url.pathname.slice(idx + marker.length));
  } catch {
    return null;
  }
}

router.move('*', async (req, res) => {
  const segments = segmentsFromReq(req);
  const ownerId = req.user.id;
  const node = resolveNode(ownerId, segments);
  if (!node) return res.status(404).send('Not found');

  const destSegments = parseDestinationSegments(req);
  if (!destSegments || !destSegments.length) return res.status(400).send('Missing or invalid Destination header');

  const destParentId = resolveParentId(ownerId, destSegments);
  if (destParentId === undefined) return res.status(409).send('Destination folder does not exist');
  if (node.type === 'folder' && isSelfOrDescendantMove(node.id, destParentId)) {
    return res.status(409).send("Can't move a folder into itself");
  }

  const destExisting = resolveNode(ownerId, destSegments);
  if (destExisting) {
    if (req.headers.overwrite === 'F') return res.status(412).send('Destination exists');
    destExisting.trashed = true;
    destExisting.trashedAt = Date.now();
    for (const d of descendantsOf(destExisting.id)) {
      d.trashed = true;
      d.trashedAt = Date.now();
    }
  }

  node.name = sanitizeName(destSegments[destSegments.length - 1]);
  node.parentId = destParentId;
  node.updatedAt = Date.now();
  logActivity({ userId: ownerId, username: req.user.username, action: 'move', targetName: node.name, details: 'via WebDAV' });
  await save();
  res.status(destExisting ? 204 : 201).end();
});

// Files only - copying a folder would mean duplicating every blob inside
// it, which is a lot of machinery for a method most WebDAV clients rarely
// exercise; unsupported for now rather than half-implemented.
router.copy('*', async (req, res) => {
  const segments = segmentsFromReq(req);
  const ownerId = req.user.id;
  const node = resolveNode(ownerId, segments);
  if (!node) return res.status(404).send('Not found');
  if (node.type !== 'file') return res.status(403).send('Copying folders is not supported');

  const destSegments = parseDestinationSegments(req);
  if (!destSegments || !destSegments.length) return res.status(400).send('Missing or invalid Destination header');
  const destParentId = resolveParentId(ownerId, destSegments);
  if (destParentId === undefined) return res.status(409).send('Destination folder does not exist');

  const destExisting = resolveNode(ownerId, destSegments);
  if (destExisting) {
    if (req.headers.overwrite === 'F') return res.status(412).send('Destination exists');
    destExisting.trashed = true;
    destExisting.trashedAt = Date.now();
  }

  const newBlobName = crypto.randomUUID();
  await fsp.copyFile(blobPath(node.blobName), blobPath(newBlobName));
  const now = Date.now();
  const copy = {
    id: crypto.randomUUID(),
    name: sanitizeName(destSegments[destSegments.length - 1]),
    type: 'file',
    parentId: destParentId,
    ownerId,
    size: node.size,
    mimeType: node.mimeType,
    blobName: newBlobName,
    contentText: node.contentText,
    trashed: false,
    trashedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  getState().nodes.push(copy);
  await save();
  res.status(destExisting ? 204 : 201).end();
});

// Fabricated, non-exclusive locking - see lib/webdavXml.js. Real enough to
// stop clients that insist on it (Windows' WebDAV client in particular)
// from refusing to PUT/DELETE, without real distributed-lock machinery
// that a single-owner personal drive doesn't need.
router.lock('*', (req, res) => {
  const token = `urn:uuid:${crypto.randomUUID()}`;
  res.setHeader('Lock-Token', `<${token}>`);
  res.status(200).type('application/xml; charset=utf-8').send(lockResponse(token, 600));
});

router.unlock('*', (req, res) => {
  res.status(204).end();
});

router.use((req, res) => {
  res.status(405).send('Method not supported');
});

export default router;
