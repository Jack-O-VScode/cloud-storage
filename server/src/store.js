import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

// Personal-scale metadata store backed by a single JSON file. There's no
// concurrent-writer story beyond this one process, so a simple in-memory
// object plus a serialized write queue is enough - no native DB dependency
// to cross-compile for ARM.

let state = { users: [], nodes: [] };
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
    state = { users: [], nodes: [] };
    persistNow();
  }
  state.users ||= [];
  state.nodes ||= [];
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

export function findNodeById(id) {
  return state.nodes.find((n) => n.id === id);
}

export function childrenOf(ownerId, parentId, { includeTrashed = false } = {}) {
  return state.nodes.filter(
    (n) => n.ownerId === ownerId && n.parentId === parentId && (includeTrashed || !n.trashed)
  );
}

export function allOwnedBy(ownerId) {
  return state.nodes.filter((n) => n.ownerId === ownerId);
}
