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
  createUser: (username, password, isAdmin) =>
    request('/users', { method: 'POST', body: { username, password, isAdmin } }),
  deleteUser: (id) => request(`/users/${id}`, { method: 'DELETE' }),

  listNodes: (parentId) => request(`/nodes?parentId=${encodeURIComponent(parentId)}`),
  listTrash: () => request('/nodes/trash'),
  search: (q) => request(`/nodes/search?q=${encodeURIComponent(q)}`),
  getNode: (id) => request(`/nodes/${id}`),
  createFolder: (name, parentId) => request('/nodes/folder', { method: 'POST', body: { name, parentId } }),
  patchNode: (id, patch) => request(`/nodes/${id}`, { method: 'PATCH', body: patch }),
  deleteNode: (id) => request(`/nodes/${id}`, { method: 'DELETE' }),
  emptyTrash: () => request('/nodes/trash', { method: 'DELETE' }),
  share: (id) => request(`/nodes/${id}/share`, { method: 'POST' }),
  unshare: (id) => request(`/nodes/${id}/share`, { method: 'DELETE' }),

  usage: () => request('/storage/usage'),

  downloadUrl: (id) => `${BASE}/nodes/${id}/download?download=1`,
  shareDownloadUrl: (token) => `${BASE}/share/${token}/download`,
};

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

export { ApiError };
