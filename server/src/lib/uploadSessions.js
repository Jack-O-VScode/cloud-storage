import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import { blobPath } from './paths.js';

// In-memory only (not part of the persisted metadata.json) - a half
// finished upload doesn't need to survive a server restart, and tracking
// large partial-file state in the durable store would be wasteful. A
// server restart mid-upload just means the client's retry loop gets a 404
// and starts that file over, same as if the tab had been closed.
const sessions = new Map();
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
// A finished session hangs around briefly so a retried "complete" (its
// first response lost to a network blip) gets the same answer again
// instead of a 404 for a file that actually uploaded fine.
const KEEP_COMPLETED_MS = 15 * 60 * 1000;

export function createSession(data) {
  const id = crypto.randomUUID();
  const now = Date.now();
  const session = {
    id,
    receivedBytes: 0,
    createdAt: now,
    lastActivityAt: now,
    completed: false,
    result: null,
    lock: Promise.resolve(),
    ...data,
  };
  sessions.set(id, session);
  return session;
}

export function getSession(id) {
  return sessions.get(id);
}

export function deleteSession(id) {
  sessions.delete(id);
}

// Runs `fn` with exclusive access to one session. Chunk writes are
// appends, so two requests for the same session must never interleave -
// e.g. a client retrying a chunk whose first attempt the server is still
// writing would otherwise pass the offset check twice and append the same
// bytes twice, silently corrupting the file.
export function withSessionLock(session, fn) {
  const run = session.lock.then(fn, fn);
  session.lock = run.catch(() => {});
  return run;
}

// Bytes already promised to in-flight uploads for an owner - counted
// against their quota up front, so several files uploading side by side
// can't each pass the check and then together overshoot it.
export function pendingBytesFor(ownerId) {
  let total = 0;
  for (const s of sessions.values()) {
    if (s.ownerId === ownerId && !s.completed) total += s.size;
  }
  return total;
}

// Cleans up sessions abandoned mid-upload (tab closed, browser crashed,
// etc.) along with their partial temp blob, so they don't quietly pile up
// on disk forever.
async function sweepStaleSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.completed) {
      if (now - session.lastActivityAt > KEEP_COMPLETED_MS) sessions.delete(id);
    } else if (now - session.lastActivityAt > STALE_AFTER_MS) {
      sessions.delete(id);
      await fsp.unlink(blobPath(session.tempBlobName)).catch(() => {});
    }
  }
}

export function scheduleUploadSessionSweep() {
  setInterval(sweepStaleSessions, 10 * 60 * 1000).unref();
}
