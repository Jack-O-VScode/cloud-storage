const BASE = '/api';

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(path, { method = 'GET', body, isForm = false } = {}) {
  const headers = {};
  if (method !== 'GET') headers['X-Requested-With'] = 'cloud-storage';
  if (body && !isForm) headers['Content-Type'] = 'application/json';

  const res = await fetch(BASE + path, {
    method,
    headers,
    credentials: 'same-origin',
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });

  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json().catch(() => ({})) : {};

  if (!res.ok) {
    throw new ApiError(data.error || `Request failed (${res.status})`, res.status);
  }
  return data;
}

export const api = {
  setupNeeded: () => request('/auth/setup-needed'),
  setup: (username, password) => request('/auth/setup', { method: 'POST', body: { username, password } }),
  login: (username, password) => request('/auth/login', { method: 'POST', body: { username, password } }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  me: () => request('/auth/me'),

  listUsers: () => request('/users'),
  createUser: (username, password, isAdmin, quotaBytes) =>
    request('/users', { method: 'POST', body: { username, password, isAdmin, quotaBytes } }),
  updateUserQuota: (id, quotaBytes) => request(`/users/${id}`, { method: 'PATCH', body: { quotaBytes } }),
  deleteUser: (id) => request(`/users/${id}`, { method: 'DELETE' }),

  listNodes: (parentId, { sortBy = 'name', sortDir = 'asc', offset = 0, limit = 200 } = {}) =>
    request(
      `/nodes?parentId=${encodeURIComponent(parentId)}&sortBy=${sortBy}&sortDir=${sortDir}&offset=${offset}&limit=${limit}`
    ),
  listTrash: () => request('/nodes/trash'),
  listStarred: () => request('/nodes/starred'),
  listRecent: () => request('/nodes/recent'),
  search: (q) => request(`/nodes/search?q=${encodeURIComponent(q)}`),
  getNode: (id) => request(`/nodes/${id}`),
  createFolder: (name, parentId) => request('/nodes/folder', { method: 'POST', body: { name, parentId } }),
  patchNode: (id, patch) => request(`/nodes/${id}`, { method: 'PATCH', body: patch }),
  deleteNode: (id) => request(`/nodes/${id}`, { method: 'DELETE' }),
  emptyTrash: () => request('/nodes/trash', { method: 'DELETE' }),
  share: (id, opts) => request(`/nodes/${id}/share`, { method: 'POST', body: opts || {} }),
  unshare: (id) => request(`/nodes/${id}/share`, { method: 'DELETE' }),
  shareBundle: (ids) => request('/nodes/share-bundle', { method: 'POST', body: { ids } }),
  patchShareBundle: (id, opts) => request(`/nodes/share-bundle/${id}`, { method: 'PATCH', body: opts || {} }),
  deleteShareBundle: (id) => request(`/nodes/share-bundle/${id}`, { method: 'DELETE' }),

  usage: () => request('/storage/usage'),

  listGrantsForFolder: (folderId) => request(`/grants/for-folder/${folderId}`),
  createGrant: (folderId, granteeUsername, permission) =>
    request('/grants', { method: 'POST', body: { folderId, granteeUsername, permission } }),
  deleteGrant: (id) => request(`/grants/${id}`, { method: 'DELETE' }),
  listSharedWithMe: () => request('/grants/shared-with-me'),

  listComments: (id) => request(`/nodes/${id}/comments`),
  addComment: (id, text) => request(`/nodes/${id}/comments`, { method: 'POST', body: { text } }),
  deleteComment: (id, commentId) => request(`/nodes/${id}/comments/${commentId}`, { method: 'DELETE' }),

  listVersions: (id) => request(`/nodes/${id}/versions`),
  restoreVersion: (id, versionId) => request(`/nodes/${id}/versions/${versionId}/restore`, { method: 'POST' }),
  versionDownloadUrl: (id, versionId) => `${BASE}/nodes/${id}/versions/${versionId}/download?download=1`,

  downloadUrl: (id) => `${BASE}/nodes/${id}/download?download=1`,
  previewUrl: (id) => `${BASE}/nodes/${id}/download`,
  thumbnailUrl: (id) => `${BASE}/nodes/${id}/thumbnail`,

  // Public share endpoints (no auth cookie needed - the token is the credential).
  shareMeta: (token) => request(`/share/${token}`),
  shareUnlock: (token, password) => request(`/share/${token}/unlock`, { method: 'POST', body: { password } }),
  shareList: (token, nodeId) =>
    request(`/share/${token}/list${nodeId ? `?nodeId=${encodeURIComponent(nodeId)}` : ''}`),
  shareDownloadUrl: (token, nodeId) =>
    `${BASE}/share/${token}/download${nodeId ? `?nodeId=${encodeURIComponent(nodeId)}` : ''}`,
  shareZipUrl: (token, nodeId) =>
    `${BASE}/share/${token}/zip${nodeId ? `?nodeId=${encodeURIComponent(nodeId)}` : ''}`,
  shareUploadUrl: (token, nodeId) =>
    `${BASE}/share/${token}/upload${nodeId ? `?nodeId=${encodeURIComponent(nodeId)}` : ''}`,

  listBackups: () => request('/backups'),
  createFullBackup: () => request('/backups/full', { method: 'POST' }),
  backupDownloadUrl: (filename) => `${BASE}/backups/${encodeURIComponent(filename)}/download`,

  listActivity: () => request('/activity'),

  updatePreferences: (prefs) => request('/auth/preferences', { method: 'PATCH', body: prefs }),
};

// Bulk zip download goes through fetch (not the JSON `request` helper)
// since the response body is binary, then gets saved via a synthetic link.
export async function downloadZip(ids) {
  const res = await fetch(BASE + '/nodes/zip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'cloud-storage' },
    credentials: 'same-origin',
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) {
    let data = {};
    try {
      data = await res.json();
    } catch {
      // ignore
    }
    throw new ApiError(data.error || `Download failed (${res.status})`, res.status);
  }
  const blob = await res.blob();
  const disposition = res.headers.get('content-disposition') || '';
  const match = /filename\*=UTF-8''([^;]+)/.exec(disposition);
  const filename = match ? decodeURIComponent(match[1]) : 'download.zip';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Bigger chunks mean fewer round trips for a large file - each chunk
// carries fixed per-request overhead (HTTP framing, a disk write on the
// server), so at 8MB an 8GB file needed ~1000 round trips just for
// bookkeeping, on top of whatever the actual transfer took.
const CHUNK_SIZE = 32 * 1024 * 1024;
const MAX_CHUNK_RETRIES = 5;

async function postJson(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'cloud-storage' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `Upload failed (${res.status})`, res.status);
  return data;
}

// Uploads one file in chunks, retrying a dropped chunk (with backoff)
// instead of the whole file having to restart - the server tells us via
// `receivedBytes` where it actually got to, so a lost response doesn't
// desync the client from what was really written.
async function uploadOneFileChunked(file, parentId, relativePath, onBytesLoaded) {
  const { sessionId } = await postJson('/upload-sessions', {
    name: file.name,
    size: file.size,
    mimeType: file.type,
    parentId,
    relativePath: relativePath || '',
  });

  let offset = 0;
  while (offset < file.size) {
    const chunk = file.slice(offset, Math.min(offset + CHUNK_SIZE, file.size));
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const res = await fetch(`${BASE}/upload-sessions/${sessionId}/chunk`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Requested-With': 'cloud-storage',
            'X-Chunk-Offset': String(offset),
          },
          credentials: 'same-origin',
          body: chunk,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (res.status === 409 && typeof data.receivedBytes === 'number') {
            offset = data.receivedBytes; // resync to where the server really is, then retry from there
            break;
          }
          throw new ApiError(data.error || `Upload failed (${res.status})`, res.status);
        }
        offset = data.receivedBytes;
        onBytesLoaded(offset);
        break;
      } catch (err) {
        if (err instanceof ApiError) throw err; // a real rejection, not a dropped connection - don't retry
        attempt += 1;
        if (attempt > MAX_CHUNK_RETRIES) {
          throw new ApiError("Upload failed after several retries - check your connection", 0);
        }
        await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 15000)));
      }
    }
  }

  const { item } = await postJson(`/upload-sessions/${sessionId}/complete`, {});
  return item;
}

// `relativePaths`, when given, must be the same length/order as `files` -
// used to recreate a folder's structure server-side instead of flattening it.
export async function uploadFiles(files, parentId, onProgress, relativePaths) {
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0) || 1;
  const perFileLoaded = new Array(files.length).fill(0);
  const items = [];
  for (let i = 0; i < files.length; i++) {
    const item = await uploadOneFileChunked(files[i], parentId, relativePaths?.[i], (loaded) => {
      perFileLoaded[i] = loaded;
      onProgress?.(perFileLoaded.reduce((a, b) => a + b, 0) / totalBytes);
    });
    items.push(item);
  }
  return { items };
}

// Uploads a single file as a new version of an existing file node, keeping
// its previous content around as history instead of it being lost.
export function uploadVersion(nodeId, file, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file, file.name);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BASE}/nodes/${nodeId}/version`);
    xhr.setRequestHeader('X-Requested-With', 'cloud-storage');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // ignore
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(data.error || `Upload failed (${xhr.status})`, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError('Network error during upload', 0));
    xhr.send(form);
  });
}

// Public counterpart of uploadFiles() for an upload-enabled shared folder -
// no session cookie is sent (there isn't one), the share token is the
// credential instead.
export function shareUploadFiles(token, files, nodeId, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const file of files) form.append('files', file, file.name);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', api.shareUploadUrl(token, nodeId));
    xhr.setRequestHeader('X-Requested-With', 'cloud-storage');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // ignore
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(data.error || `Upload failed (${xhr.status})`, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError('Network error during upload', 0));
    xhr.send(form);
  });
}

export { ApiError };
