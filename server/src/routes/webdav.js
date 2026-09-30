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
import { verifyPasswordAsync } from '../auth.js';
import { blobPath, diskUsage } from '../lib/paths.js';
import { isSelfOrDescendantMove } from '../lib/tree.js';
import { extractText } from '../lib/textExtract.js';
import { parsePathSegments, resolveNode, resolveParentId } from '../lib/webdavPath.js';
import { multistatus, nodePropResponse, lockResponse, proppatchResponse } from '../lib/webdavXml.js';
import { trashNode } from '../lib/trash.js';
import { maybeGenerateThumbnail, replaceFileContent } from '../lib/versions.js';
import { sanitizeName, uniqueName } from '../lib/names.js';
import { streamFile } from './nodes.js';

const router = Router();

// WebDAV clients (Explorer's "Map network drive", Finder's "Connect to
// Server", rclone, Cyberduck, ...) authenticate with HTTP Basic Auth on
// every request rather than a session cookie - this only carries real
// protection over HTTPS, same as any Basic Auth endpoint.
//
// A mounted drive fires off requests constantly (Explorer re-lists
// folders, probes for desktop.ini/thumbs, ...), and a bcrypt check costs a
// few hundred ms of CPU each - so a credential that already checked out is
// remembered (keyed by a hash of the header, never the password itself)
// for a few minutes instead of being re-verified on every single request.
const AUTH_CACHE_MS = 10 * 60 * 1000;
const authCache = new Map(); // sha256(header) -> { userId, passwordHash, expiresAt }

// Wrong-password attempts per IP, so the WebDAV endpoint can't be used to
// brute-force an account's password (the login page has its own limiter).
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 20;
const failures = new Map(); // ip -> { count, resetAt }

function tooManyFailures(ip) {
  const entry = failures.get(ip);
  if (!entry) return false;
  if (Date.now() > entry.resetAt) {
    failures.delete(ip);
    return false;
  }
  return entry.count >= MAX_FAILURES;
}

function recordFailure(ip) {
  const now = Date.now();
  const entry = failures.get(ip);
  if (!entry || now > entry.resetAt) failures.set(ip, { count: 1, resetAt: now + FAILURE_WINDOW_MS });
  else entry.count += 1;
  if (failures.size > 10000) failures.clear();
}

async function requireBasicAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const match = /^Basic\s+(.+)$/i.exec(header);
  const challenge = () => {
    res.setHeader('WWW-Authenticate', 'Basic realm="Cloud Storage"');
    return res.status(401).send('Authentication required');
  };
  if (!match) return challenge();

  const cacheKey = crypto.createHash('sha256').update(match[1]).digest('hex');
  const cached = authCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    const user = findUserById(cached.userId);
    // A password change (new hash) or deleted account invalidates it.
    if (user && user.passwordHash === cached.passwordHash) {
      req.user = user;
      return next();
    }
  }
  authCache.delete(cacheKey);

  if (tooManyFailures(req.ip)) {
    res.setHeader('Retry-After', '900');
    return res.status(429).send('Too many failed sign-in attempts - try again in 15 minutes');
  }

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
  const ok = user ? await verifyPasswordAsync(password, user.passwordHash) : false;
  if (!ok) {
    recordFailure(req.ip);
    return challenge();
  }

  if (authCache.size > 1000) authCache.clear();
  authCache.set(cacheKey, { userId: user.id, passwordHash: user.passwordHash, expiresAt: Date.now() + AUTH_CACHE_MS });
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
const XML_BODY_METHODS = new Set(['PROPFIND', 'PROPPATCH', 'LOCK']);
router.use((req, res, next) => {
  if (!XML_BODY_METHODS.has(req.method)) return next();
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size <= 1024 * 1024) chunks.push(c);
  });
  req.on('end', () => {
    req.xmlBody = Buffer.concat(chunks).toString('utf-8');
    next();
  });
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
  res.setHeader('Allow', 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK');
  res.status(200).end();
});

// RFC 4331 quota properties for the drive root - without these, clients
// like Windows Explorer show a made-up placeholder size instead of your
// real usage/free space.
async function rootQuota(user) {
  const used = allOwnedBy(user.id)
    .filter((n) => n.type === 'file' && !n.trashed)
    .reduce((sum, n) => sum + (n.size || 0), 0);
  if (user.quotaBytes) {
    return { used, available: Math.max(0, user.quotaBytes - used) };
  }
  const disk = await diskUsage();
  return { used, available: disk.free ?? 0 };
}

router.propfind('*', async (req, res) => {
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

  const quota = segments.length ? null : await rootQuota(req.user);
  const entries = [nodePropResponse(node, hrefFor(segments, true), quota)];
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

// Range requests are honoured (via the same streamer the web app uses) so
// seeking in a video opened straight off the mounted drive doesn't have to
// pull the whole file down first.
router.get('*', (req, res) => {
  const segments = segmentsFromReq(req);
  const node = resolveNode(req.user.id, segments);
  if (!node || node.type !== 'file') return res.status(404).send('Not found');
  res.setHeader('Last-Modified', new Date(node.updatedAt || node.createdAt).toUTCString());
  streamFile(req, res, node);
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

  // Refuse an obviously over-quota upload before reading gigabytes of it.
  const declaredLength = parseInt(req.headers['content-length'], 10);
  if (owner?.quotaBytes && Number.isFinite(declaredLength)) {
    const currentlyUsed = allOwnedBy(ownerId)
      .filter((n) => n.type === 'file' && !n.trashed && n.id !== existing?.id)
      .reduce((sum, n) => sum + (n.size || 0), 0);
    if (currentlyUsed + declaredLength > owner.quotaBytes) return res.status(507).send('Storage quota exceeded');
  }

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
      return res.status(507).send('Storage quota exceeded');
    }
  }

  const mimeType = mime.lookup(name) || 'application/octet-stream';
  const now = Date.now();
  const state = getState();

  if (existing) {
    // Saving over a file from the mounted drive keeps what was there as a
    // version (restorable from the web app's Version history), same as a
    // replace done in the browser - except an empty placeholder, which
    // Windows creates with a 0-byte PUT right before sending the real
    // content, and isn't worth a history slot.
    await replaceFileContent(existing, { blobName, size: stat.size, mimeType }, { keepVersion: (existing.size || 0) > 0 });
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
  trashNode(node);
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

  // Names match case-insensitively (like Windows itself), so renaming
  // "a.txt" to "A.txt" resolves the destination to the very same item -
  // that's a rename, not an overwrite of something else.
  const found = resolveNode(ownerId, destSegments);
  const destExisting = found && found.id !== node.id ? found : null;
  if (destExisting) {
    if (req.headers.overwrite === 'F') return res.status(412).send('Destination exists');
    trashNode(destExisting);
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
  if (destExisting && destExisting.id === node.id) return res.status(403).send('Source and destination are the same');
  if (destExisting) {
    if (req.headers.overwrite === 'F') return res.status(412).send('Destination exists');
    trashNode(destExisting);
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
    ...(node.contentText ? { contentText: node.contentText } : {}),
    trashed: false,
    trashedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  getState().nodes.push(copy);
  await save();
  res.status(destExisting ? 204 : 201).end();
});

// Clients set their own metadata this way (Windows sends its file
// timestamps/attributes right after every copy). Nothing here stores
// arbitrary properties, but answering "done" rather than 405 matters:
// Windows reports the whole copy as failed if this step errors.
router.proppatch('*', (req, res) => {
  const segments = segmentsFromReq(req);
  const node = segments.length ? resolveNode(req.user.id, segments) : { type: 'folder' };
  if (!node) return res.status(404).send('Not found');
  res
    .status(207)
    .type('application/xml; charset=utf-8')
    .send(proppatchResponse(hrefFor(segments, node.type === 'folder'), req.xmlBody || ''));
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
