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

  listNodes: (parentId) => request(`/nodes?parentId=${encodeURIComponent(parentId)}`),
  listTrash: () => request('/nodes/trash'),
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

  downloadUrl: (id) => `${BASE}/nodes/${id}/download?download=1`,
  previewUrl: (id) => `${BASE}/nodes/${id}/download`,

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

// XHR (not fetch) so we get upload progress events.
// `relativePaths`, when given, must be the same length/order as `files` -
// used to recreate a folder's structure server-side instead of flattening it.
export function uploadFiles(files, parentId, onProgress, relativePaths) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('parentId', parentId);
    for (const file of files) form.append('files', file, file.name);
    if (relativePaths) form.append('relativePaths', JSON.stringify(relativePaths));

    const xhr = new XMLHttpRequest();
    xhr.open('POST', BASE + '/nodes/upload');
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
