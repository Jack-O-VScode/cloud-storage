import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

// Personal-scale metadata store backed by a single JSON file. There's no
// concurrent-writer story beyond this one process, so a simple in-memory
// object plus a serialized write queue is enough - no native DB dependency
// to cross-compile for ARM.

let state = { users: [], nodes: [], activity: [], bundles: [], grants: [] };
let writeQueue = Promise.resolve();
let dirty = false;

function ensureDirs() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.blobDir, { recursive: true });
}

export function loadStore() {
  ensureDirs();
  if (fs.existsSync(config.metaFile)) {
    const raw = fs.readFileSync(config.metaFile, 'utf-8');
    try {
      state = JSON.parse(raw);
    } catch (err) {
      throw new Error(`metadata.json is corrupt and could not be parsed: ${err.message}`);
    }
  } else {
    state = { users: [], nodes: [], activity: [], bundles: [], grants: [] };
    persistNow();
  }
  state.users ||= [];
  state.nodes ||= [];
  state.activity ||= [];
  state.bundles ||= [];
  state.grants ||= [];
  // Grants used to be folder-only and stored their target as `folderId`;
  // they can now target any node (file or folder), stored as `nodeId`.
  for (const g of state.grants) {
    if (g.folderId && !g.nodeId) {
      g.nodeId = g.folderId;
      delete g.folderId;
    }
  }
  return state;
}

function persistNow() {
  const tmpFile = config.metaFile + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2));
  fs.renameSync(tmpFile, config.metaFile);
  dirty = false;
}

// All mutations go through save() which queues the actual disk write so
// concurrent requests can't interleave partial writes to metadata.json.
export function save() {
  dirty = true;
  writeQueue = writeQueue.then(async () => {
    if (!dirty) return;
    await fsp.mkdir(config.dataDir, { recursive: true });
    const tmpFile = config.metaFile + '.tmp';
    await fsp.writeFile(tmpFile, JSON.stringify(state, null, 2));
    await fsp.rename(tmpFile, config.metaFile);
    dirty = false;
  });
  return writeQueue;
}

export function getState() {
  return state;
}

export function findUserByUsername(username) {
  const lower = username.toLowerCase();
  return state.users.find((u) => u.username.toLowerCase() === lower);
}

export function findUserById(id) {
  return state.users.find((u) => u.id === id);
}

// id -> node lookup, rebuilt lazily whenever state.nodes is reassigned
// (every removal in this codebase filters into a new array) or grows (a
// push). A linear scan per lookup got expensive in the loops that walk
// parent chains (breadcrumbs, access checks) once a drive holds tens of
// thousands of files.
let nodeIndex = new Map();
let indexedArray = null;
let indexedLength = -1;

export function findNodeById(id) {
  if (!id) return undefined;
  if (indexedArray !== state.nodes || indexedLength !== state.nodes.length) {
    nodeIndex = new Map(state.nodes.map((n) => [n.id, n]));
    indexedArray = state.nodes;
    indexedLength = state.nodes.length;
  }
  return nodeIndex.get(id);
}

export function childrenOf(ownerId, parentId, { includeTrashed = false } = {}) {
  return state.nodes.filter(
    (n) => n.ownerId === ownerId && n.parentId === parentId && (includeTrashed || !n.trashed)
  );
}

export function allOwnedBy(ownerId) {
  return state.nodes.filter((n) => n.ownerId === ownerId);
}

export function findBundleById(id) {
  return state.bundles.find((b) => b.id === id);
}

export function findBundleByToken(token) {
  return state.bundles.find((b) => b.token === token);
}

export function findGrantById(id) {
  return state.grants.find((g) => g.id === id);
}

export function findGrant(nodeId, granteeUserId) {
  return state.grants.find((g) => g.nodeId === nodeId && g.granteeUserId === granteeUserId);
}

export function grantsForNode(nodeId) {
  return state.grants.filter((g) => g.nodeId === nodeId);
}

export function grantsForUser(userId) {
  return state.grants.filter((g) => g.granteeUserId === userId);
}

const MAX_ACTIVITY_ENTRIES = 1000;

// Records a line in the activity log. Doesn't call save() itself - callers
// already persist state after their own mutation, so this just piggybacks
// on that write; routes with nothing else to persist (e.g. login) must
// call save() themselves.
const COALESCE_WINDOW_MS = 2 * 60 * 1000;
const COALESCED_ACTIONS = new Set(['upload', 'share_upload']);

export function logActivity({ userId, username, action, targetName, details }) {
  state.activity ||= [];
  // A batch of uploads finishes one file at a time (each its own request),
  // which would otherwise bury everything else in the log under hundreds
  // of near-identical lines - fold them into one "N files" entry instead.
  if (COALESCED_ACTIONS.has(action)) {
    const last = state.activity[state.activity.length - 1];
    if (
      last &&
      last.action === action &&
      last.userId === (userId || null) &&
      last.details === (details || null) &&
      Date.now() - last.timestamp < COALESCE_WINDOW_MS
    ) {
      last.count = (last.count || 1) + 1;
      last.targetName = `${last.count} files`;
      last.timestamp = Date.now();
      return;
    }
  }
  state.activity.push({
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    userId: userId || null,
    username: username || null,
    action,
    targetName: targetName || null,
    details: details || null,
  });
  if (state.activity.length > MAX_ACTIVITY_ENTRIES) {
    state.activity.splice(0, state.activity.length - MAX_ACTIVITY_ENTRIES);
  }
}

export function getActivity(limit = 200) {
  return (state.activity || []).slice(-limit).reverse();
}
