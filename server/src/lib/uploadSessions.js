import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import { blobPath } from './paths.js';

// In-memory only (not part of the persisted metadata.json) - a half
// finished upload doesn't need to survive a server restart, and tracking
// large partial-file state in the durable store would be wasteful. A
// server restart mid-upload just means the client's retry loop gets a 404
// and starts that file over, same as if the tab had been closed.
const sessions = new Map();
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function createSession(data) {
  const id = crypto.randomUUID();
  const session = { id, receivedBytes: 0, createdAt: Date.now(), ...data };
  sessions.set(id, session);
  return session;
}

export function getSession(id) {
  return sessions.get(id);
}

export function deleteSession(id) {
  sessions.delete(id);
}

// Cleans up sessions abandoned mid-upload (tab closed, browser crashed,
// etc.) along with their partial temp blob, so they don't quietly pile up
// on disk forever.
async function sweepStaleSessions() {
  const cutoff = Date.now() - SESSION_MAX_AGE_MS;
  for (const [id, session] of sessions) {
    if (session.createdAt < cutoff) {
      sessions.delete(id);
      await fsp.unlink(blobPath(session.tempBlobName)).catch(() => {});
    }
  }
}

export function scheduleUploadSessionSweep() {
  setInterval(sweepStaleSessions, 60 * 60 * 1000).unref();
}
