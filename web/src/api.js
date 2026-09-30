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
  checkConflicts: (parentId, paths) => request('/nodes/check-conflicts', { method: 'POST', body: { parentId, paths } }),
  share: (id, opts) => request(`/nodes/${id}/share`, { method: 'POST', body: opts || {} }),
  unshare: (id) => request(`/nodes/${id}/share`, { method: 'DELETE' }),
  shareBundle: (ids, opts) => request('/nodes/share-bundle', { method: 'POST', body: { ids, ...(opts || {}) } }),
  patchShareBundle: (id, opts) => request(`/nodes/share-bundle/${id}`, { method: 'PATCH', body: opts || {} }),
  deleteShareBundle: (id) => request(`/nodes/share-bundle/${id}`, { method: 'DELETE' }),
  listShares: () => request('/shares'),

  usage: () => request('/storage/usage'),

  listGrantsForNode: (nodeId) => request(`/grants/for-node/${nodeId}`),
  createGrant: (nodeId, granteeUsername, permission) =>
    request('/grants', { method: 'POST', body: { nodeId, granteeUsername, permission } }),
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
  shareThumbnailUrl: (token, nodeId) => `${BASE}/share/${token}/thumbnail?nodeId=${encodeURIComponent(nodeId)}`,
  shareUploadBase: (token) => `${BASE}/share/${token}/upload-sessions`,

  listBackups: () => request('/backups'),
  createFullBackup: () => request('/backups/full', { method: 'POST' }),
  backupDownloadUrl: (filename) => `${BASE}/backups/${encodeURIComponent(filename)}/download`,

  listActivity: () => request('/activity'),

  updatePreferences: (prefs) => request('/auth/preferences', { method: 'PATCH', body: prefs }),
};

// Tracks recent (loadedBytes, time) samples in a trailing window so a
// speed reading is a smoothed rate rather than jumping around with every
// chunk/read event - a single 32MB chunk landing all at once would
// otherwise read as an absurd instantaneous spike.
function createSpeedTracker(windowMs = 3000) {
  const samples = [];
  return (loadedBytes) => {
    const now = performance.now();
    samples.push({ t: now, bytes: loadedBytes });
    while (samples.length > 1 && now - samples[0].t > windowMs) samples.shift();
    const dt = (now - samples[0].t) / 1000;
    return dt > 0 ? (loadedBytes - samples[0].bytes) / dt : 0;
  };
}

// Bulk zip download goes through fetch (not the JSON `request` helper)
// since the response body is binary, then gets saved via a synthetic link.
// The zip is streamed/generated on the fly server-side with no known
// final size, so `onProgress` only ever gets bytes-so-far and a speed
// reading - never a total or a percentage.
export async function downloadZip(ids, onProgress) {
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

  const disposition = res.headers.get('content-disposition') || '';
  const match = /filename\*=UTF-8''([^;]+)/.exec(disposition);
  const filename = match ? decodeURIComponent(match[1]) : 'download.zip';

  const chunks = [];
  const reader = res.body?.getReader();
  if (reader) {
    const speedTracker = createSpeedTracker();
    let loadedBytes = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loadedBytes += value.length;
      onProgress?.({ loadedBytes, bytesPerSecond: speedTracker(loadedBytes) });
    }
  } else {
    // A browser without a streamable response body - fall back to
    // buffering it whole, with no progress reporting along the way.
    chunks.push(new Uint8Array(await res.arrayBuffer()));
  }

  const blob = new Blob(chunks, { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Revoking straight away can cancel the save in Safari before it has
  // actually started reading the blob.
  setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
}

export { ApiError };
