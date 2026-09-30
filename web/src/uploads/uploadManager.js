// One app-wide upload queue, shared by the drive and public share pages,
// feeding the upload panel. Each file uploads through a resumable,
// chunked session (see server/src/routes/uploadSessions.js): a dropped
// connection retries just the chunk in flight, a failed file never stops
// the rest of the queue, and any file can be cancelled or retried on its
// own.

// Bigger chunks mean fewer round trips for a large file - each chunk
// carries fixed per-request overhead (HTTP framing, a disk write on the
// server), so at 8MB an 8GB file needed ~1000 round trips just for
// bookkeeping, on top of whatever the actual transfer took.
const CHUNK_SIZE = 32 * 1024 * 1024;
const MAX_RETRIES = 5;
// A few files at once keeps a folder of small photos moving quickly
// (per-file overhead overlaps) without starving one big file of bandwidth.
const CONCURRENCY = 3;

class UploadError extends Error {
  constructor(message, { retryable = false, status = 0 } = {}) {
    super(message);
    this.retryable = retryable;
    this.status = status;
  }
}
class CancelledError extends Error {}

let tasks = [];
let nextId = 1;
let active = 0;
const listeners = new Set();
const completionListeners = new Set();
let snapshot = { tasks: [], stats: null };
let emitTimer = null;
let speedSamples = [];

function computeStats() {
  const live = tasks.filter((t) => t.status !== 'cancelled' && t.status !== 'skipped');
  if (!live.length) return null;
  const totalBytes = live.reduce((s, t) => s + t.size, 0);
  const loadedBytes = live.reduce((s, t) => s + (t.status === 'done' ? t.size : t.loaded), 0);
  const now = performance.now();
  speedSamples.push({ t: now, bytes: loadedBytes });
  while (speedSamples.length > 1 && now - speedSamples[0].t > 4000) speedSamples.shift();
  const dt = (now - speedSamples[0].t) / 1000;
  const bytesPerSecond = dt > 0.5 ? Math.max(0, (loadedBytes - speedSamples[0].bytes) / dt) : 0;
  const count = (status) => live.filter((t) => t.status === status).length;
  return {
    totalBytes,
    loadedBytes,
    bytesPerSecond,
    total: live.length,
    done: count('done'),
    failed: count('error'),
    inProgress: live.filter((t) => t.status === 'queued' || t.status === 'uploading' || t.status === 'finishing').length,
  };
}

function publish() {
  emitTimer = null;
  snapshot = {
    tasks: tasks.map((t) => ({
      id: t.id,
      name: t.name,
      size: t.size,
      loaded: t.loaded,
      status: t.status,
      error: t.error,
      targetLabel: t.targetLabel,
      replaced: t.replaced,
      finalName: t.finalName,
    })),
    stats: computeStats(),
  };
  for (const l of listeners) l();
}

// Progress ticks arrive many times a second; a status change (started,
// finished, failed) is shown right away, byte counts at most ~5x/second.
function emit(immediate = false) {
  if (immediate) {
    if (emitTimer) clearTimeout(emitTimer);
    publish();
    return;
  }
  if (!emitTimer) emitTimer = setTimeout(publish, 200);
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getSnapshot() {
  return snapshot;
}

// Called with each task as it finishes successfully - pages use it to
// refresh whatever folder they're showing.
export function onUploadComplete(fn) {
  completionListeners.add(fn);
  return () => completionListeners.delete(fn);
}

export function hasActiveUploads() {
  return tasks.some((t) => t.status === 'queued' || t.status === 'uploading' || t.status === 'finishing');
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    if (!hasActiveUploads()) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

async function postJson(url, body, method = 'POST') {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'cloud-storage' },
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new UploadError('Network error', { retryable: true });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 5xx from a proxy mid-restart is worth another go; 4xx is a real "no".
    throw new UploadError(data.error || `Upload failed (${res.status})`, { retryable: res.status >= 500, status: res.status });
  }
  return data;
}

function putChunk(task, url, chunk, offset, onChunkBytes) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    task.xhr = xhr;
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Requested-With', 'cloud-storage');
    xhr.setRequestHeader('X-Chunk-Offset', String(offset));
    // XHR (not fetch) so upload.onprogress gives byte-level progress
    // DURING a chunk - fetch only resolves once the whole chunk is done.
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onChunkBytes(e.loaded);
    };
    xhr.onload = () => {
      task.xhr = null;
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // ignore
      }
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data });
    };
    xhr.onerror = () => {
      task.xhr = null;
      reject(new UploadError('Network error', { retryable: true }));
    };
    xhr.onabort = () => {
      task.xhr = null;
      reject(new CancelledError());
    };
    xhr.send(chunk);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retries `fn` on dropped connections / server hiccups with backoff; a
// real rejection (bad request, quota, permission) fails straight away.
async function withRetries(task, fn) {
  for (let attempt = 0; ; attempt++) {
    if (task.cancelRequested) throw new CancelledError();
    try {
      return await fn();
    } catch (err) {
      if (err instanceof CancelledError || !err.retryable || attempt >= MAX_RETRIES) throw err;
      await sleep(Math.min(1000 * 2 ** attempt, 15000));
    }
  }
}

async function runTask(task) {
  const { base, file } = task;
  const { sessionId } = await withRetries(task, () =>
    postJson(base, {
      ...task.initBody,
      name: file.name,
      size: file.size,
      mimeType: file.type || '',
      relativePath: task.relativePath || '',
    })
  );
  task.sessionId = sessionId;

  let offset = 0;
  while (offset < file.size) {
    const start = offset;
    const chunk = file.slice(start, Math.min(start + CHUNK_SIZE, file.size));
    const result = await withRetries(task, async () => {
      const r = await putChunk(task, `${base}/${sessionId}/chunk`, chunk, start, (bytes) => {
        task.loaded = start + bytes;
        emit();
      });
      if (r.ok) return r;
      // The server is somewhere else than we thought (a lost response):
      // resume from wherever it actually got to.
      if (r.status === 409 && typeof r.data.receivedBytes === 'number') return r;
      throw new UploadError(r.data.error || `Upload failed (${r.status})`, {
        retryable: r.status >= 500 || r.status === 0,
        status: r.status,
      });
    });
    offset = result.data.receivedBytes;
    task.loaded = offset;
    emit();
  }

  task.status = 'finishing';
  emit(true);
  // Safe to retry: the server answers a repeated "complete" with the same
  // result instead of filing the file twice.
  return withRetries(task, () => postJson(`${base}/${sessionId}/complete`, {}));
}

async function start(task) {
  active += 1;
  task.status = 'uploading';
  task.loaded = 0;
  task.error = null;
  emit(true);
  try {
    const result = await runTask(task);
    task.status = 'done';
    task.loaded = task.size;
    task.replaced = Boolean(result.replaced);
    task.finalName = result.item?.name || task.name;
    task.result = result.item || null;
    for (const fn of completionListeners) {
      try {
        fn(task);
      } catch {
        // a listener's problem isn't the upload's
      }
    }
  } catch (err) {
    if (err instanceof CancelledError || task.cancelRequested) {
      task.status = 'cancelled';
      if (task.sessionId) postJson(`${task.base}/${task.sessionId}`, undefined, 'DELETE').catch(() => {});
    } else {
      task.status = 'error';
      task.error = err.status === 404 && task.sessionId ? 'Upload expired - retry to start again' : err.message;
    }
  } finally {
    task.xhr = null;
    active -= 1;
    emit(true);
    pump();
  }
}

function pump() {
  while (active < CONCURRENCY) {
    const next = tasks.find((t) => t.status === 'queued');
    if (!next) return;
    start(next);
  }
}

// `items`: [{ file, relativePath?, initBody?, targetLabel? }]. `base` is the
// upload-session endpoint: '/api/upload-sessions' for a signed-in user,
// '/api/share/<token>/upload-sessions' for a visitor on a shared link.
export function enqueue(items, { base = '/api/upload-sessions' } = {}) {
  if (!items.length) return;
  if (!hasActiveUploads()) {
    // A fresh batch after the last one finished - start the panel over.
    tasks = tasks.filter((t) => t.status === 'error');
    speedSamples = [];
  }
  for (const item of items) {
    tasks.push({
      id: nextId++,
      file: item.file,
      name: item.file.name,
      size: item.file.size,
      relativePath: item.relativePath || '',
      initBody: item.initBody || {},
      targetLabel: item.targetLabel || '',
      base,
      status: 'queued',
      loaded: 0,
      error: null,
      sessionId: null,
      xhr: null,
      cancelRequested: false,
    });
  }
  emit(true);
  pump();
}

export function cancel(id) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  task.cancelRequested = true;
  if (task.status === 'queued') task.status = 'cancelled';
  else if (task.xhr) task.xhr.abort();
  emit(true);
}

export function cancelAll() {
  for (const t of tasks) {
    if (t.status === 'queued' || t.status === 'uploading' || t.status === 'finishing') cancel(t.id);
  }
}

export function retry(id) {
  const task = tasks.find((t) => t.id === id);
  if (!task || (task.status !== 'error' && task.status !== 'cancelled')) return;
  Object.assign(task, { status: 'queued', loaded: 0, error: null, sessionId: null, cancelRequested: false });
  emit(true);
  pump();
}

export function retryAllFailed() {
  for (const t of tasks) if (t.status === 'error') retry(t.id);
}

// Closing the panel: drops finished entries (in-progress ones stay).
export function clearFinished() {
  tasks = tasks.filter((t) => t.status === 'queued' || t.status === 'uploading' || t.status === 'finishing');
  if (!tasks.length) speedSamples = [];
  emit(true);
}
