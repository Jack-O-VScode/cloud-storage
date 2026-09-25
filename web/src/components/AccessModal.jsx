import React, { useCallback, useEffect, useState } from 'react';
import Modal from './Modal.jsx';
import { api } from '../api.js';

const PERMISSION_LABELS = {
  view: 'Can view & download',
  upload: 'Can view & upload',
  edit: 'Can edit (rename/move/delete)',
};

export default function AccessModal({ node, onClose }) {
  const [grants, setGrants] = useState(null);
  const [username, setUsername] = useState('');
  const [permission, setPermission] = useState('view');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api
      .listGrantsForFolder(node.id)
      .then((data) => setGrants(data.grants))
      .catch((e) => setError(e.message));
  }, [node.id]);

  useEffect(() => {
    load();
  }, [load]);

  const addGrant = async (e) => {
    e.preventDefault();
    if (!username.trim()) return;
    setBusy(true);
    setError('');
    try {
      const data = await api.createGrant(node.id, username.trim(), permission);
      setGrants(data.grants);
      setUsername('');
      setPermission('view');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const changePermission = async (grant, newPermission) => {
    setBusy(true);
    setError('');
    try {
      const data = await api.createGrant(node.id, grant.granteeUsername, newPermission);
      setGrants(data.grants);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (grant) => {
    setBusy(true);
    setError('');
    try {
      const data = await api.deleteGrant(grant.id);
      setGrants(data.grants);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Manage access — ${node.name}`}
      onClose={onClose}
      footer={
        <button className="btn" onClick={onClose}>
          Close
        </button>
      }
    >
      <p className="muted small">
        People you add here can browse into this folder (and, depending on the level you pick, upload or edit its
        contents) from their own account - separate from public share links.
      </p>

      {grants === null && <p className="muted">Loading…</p>}
      {grants?.length === 0 && <p className="muted small">Not shared with anyone yet.</p>}
      {grants?.map((g) => (
        <div key={g.id} className="access-row">
          <span className="access-row-name">{g.granteeUsername}</span>
          <select
            className="text-input access-row-select"
            value={g.permission}
            onChange={(e) => changePermission(g, e.target.value)}
            disabled={busy}
          >
            {Object.entries(PERMISSION_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <button className="link-btn danger" onClick={() => revoke(g)} disabled={busy}>
            Remove
          </button>
        </div>
      ))}

      <hr className="divider" />

      <form onSubmit={addGrant} className="access-form">
        <input
          className="text-input"
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <select className="text-input access-row-select" value={permission} onChange={(e) => setPermission(e.target.value)}>
          {Object.entries(PERMISSION_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <button className="btn btn-primary" type="submit" disabled={busy || !username.trim()}>
          Grant access
        </button>
      </form>

      {error && <p className="form-error">{error}</p>}
    </Modal>
  );
}
