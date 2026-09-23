import React, { useEffect, useState } from 'react';
import Modal from './Modal.jsx';
import { api } from '../api.js';
import { formatBytes } from '../utils/format.js';
import { useAuth } from '../context/AuthContext.jsx';

export default function UsersAdminModal({ onClose }) {
  const { user: me } = useAuth();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ username: '', password: '', isAdmin: false });
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
    setCreating(true);
    try {
      await api.createUser(form.username, form.password, form.isAdmin);
      setForm({ username: '', password: '', isAdmin: false });
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

  return (
    <Modal title="Manage users" onClose={onClose} width={480} footer={<button className="btn" onClick={onClose}>Close</button>}>
      {loading && <p className="muted">Loading…</p>}
      <div className="users-list">
        {users.map((u) => (
          <div key={u.id} className="users-row">
            <div>
              <strong>{u.username}</strong> {u.isAdmin && <span className="badge">admin</span>}
              <div className="muted small">{formatBytes(u.bytesUsed)} used</div>
            </div>
            {u.id !== me.id && (
              <button className="link-btn danger" onClick={() => removeUser(u.id)}>
                Remove
              </button>
            )}
          </div>
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
