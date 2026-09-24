import React, { useEffect, useState } from 'react';
import Modal from './Modal.jsx';
import { api } from '../api.js';
import { formatBytes } from '../utils/format.js';
import { useAuth } from '../context/AuthContext.jsx';

const GB = 1024 * 1024 * 1024;

function gbToBytes(gbText) {
  const trimmed = gbText.trim();
  if (!trimmed) return 0; // unlimited
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 ? Math.floor(n * GB) : null; // null = invalid
}

// Avoids showing scientific notation / long float noise for the initial
// value of the quota input.
function bytesToGbText(bytes) {
  if (!bytes) return '';
  return Number((bytes / GB).toFixed(4)).toString();
}

function UserRow({ u, isSelf, onRemove, onQuotaSaved }) {
  const [quotaText, setQuotaText] = useState(bytesToGbText(u.quotaBytes));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const dirty = quotaText !== bytesToGbText(u.quotaBytes);

  const saveQuota = async () => {
    const bytes = gbToBytes(quotaText);
    if (bytes === null) {
      setError('Enter a positive number, or leave blank for unlimited');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const { user } = await api.updateUserQuota(u.id, bytes);
      onQuotaSaved(user);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="users-row">
      <div>
        <strong>{u.username}</strong> {u.isAdmin && <span className="badge">admin</span>}
        <div className="muted small">
          {formatBytes(u.bytesUsed)} used{u.quotaBytes ? ` of ${formatBytes(u.quotaBytes)}` : ' · unlimited'}
        </div>
        <div className="quota-edit-row">
          <input
            className="text-input quota-input"
            type="number"
            min="0"
            step="any"
            placeholder="Unlimited"
            value={quotaText}
            onChange={(e) => setQuotaText(e.target.value)}
          />
          <span className="muted small">GB</span>
          {dirty && (
            <button className="link-btn" onClick={saveQuota} disabled={saving}>
              Save
            </button>
          )}
        </div>
        {error && <p className="form-error small">{error}</p>}
      </div>
      {!isSelf && (
        <button className="link-btn danger" onClick={() => onRemove(u.id)}>
          Remove
        </button>
      )}
    </div>
  );
}

export default function UsersAdminModal({ onClose }) {
  const { user: me } = useAuth();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ username: '', password: '', isAdmin: false, quotaGb: '' });
  const [creating, setCreating] = useState(false);

  const load = () => api.listUsers().then((d) => setUsers(d.users));

  useEffect(() => {
    load()
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const createUser = async (e) => {
    e.preventDefault();
    setError('');
    const quotaBytes = gbToBytes(form.quotaGb);
    if (quotaBytes === null) {
      setError('Quota must be a positive number, or left blank for unlimited');
      return;
    }
    setCreating(true);
    try {
      await api.createUser(form.username, form.password, form.isAdmin, quotaBytes);
      setForm({ username: '', password: '', isAdmin: false, quotaGb: '' });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const removeUser = async (id) => {
    if (!confirm('Delete this user? Their files stay on disk but they lose access.')) return;
    await api.deleteUser(id);
    load();
  };

  const onQuotaSaved = (updatedUser) => {
    setUsers((prev) => prev.map((u) => (u.id === updatedUser.id ? updatedUser : u)));
  };

  return (
    <Modal title="Manage users" onClose={onClose} width={480} footer={<button className="btn" onClick={onClose}>Close</button>}>
      {loading && <p className="muted">Loading…</p>}
      <div className="users-list">
        {users.map((u) => (
          <UserRow key={u.id} u={u} isSelf={u.id === me.id} onRemove={removeUser} onQuotaSaved={onQuotaSaved} />
        ))}
      </div>
      <hr className="divider" />
      <form onSubmit={createUser} className="new-user-form">
        <label className="field-label">Add a user</label>
        <input
          className="text-input"
          placeholder="Username"
          value={form.username}
          onChange={(e) => setForm({ ...form, username: e.target.value })}
        />
        <input
          className="text-input"
          type="password"
          placeholder="Password (8+ characters)"
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
        />
        <input
          className="text-input"
          type="number"
          min="0"
          step="any"
          placeholder="Storage quota in GB (blank = unlimited)"
          value={form.quotaGb}
          onChange={(e) => setForm({ ...form, quotaGb: e.target.value })}
        />
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={form.isAdmin}
            onChange={(e) => setForm({ ...form, isAdmin: e.target.checked })}
          />
          Admin
        </label>
        {error && <p className="form-error">{error}</p>}
        <button className="btn btn-primary" disabled={creating}>
          Add user
        </button>
      </form>
    </Modal>
  );
}
