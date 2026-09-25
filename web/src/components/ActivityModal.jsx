import React, { useEffect, useState } from 'react';
import Modal from './Modal.jsx';
import { api } from '../api.js';

const ACTION_LABELS = {
  login: 'logged in',
  create_folder: 'created folder',
  upload: 'uploaded',
  rename: 'renamed',
  move: 'moved',
  trash: 'trashed',
  restore: 'restored',
  delete_forever: 'permanently deleted',
  empty_trash: 'emptied trash',
  share: 'shared',
  unshare: 'revoked share link for',
  create_user: 'added user',
  delete_user: 'removed user',
  update_quota: 'updated quota for',
  create_full_backup: 'created a full backup',
  auto_empty_trash: 'auto-emptied trash',
};

function timeAgo(ts) {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function ActivityModal({ onClose }) {
  const [activity, setActivity] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .listActivity()
      .then((d) => setActivity(d.activity))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <Modal title="Activity" onClose={onClose} width={520} footer={<button className="btn" onClick={onClose}>Close</button>}>
      {loading && <p className="muted">Loading…</p>}
      {error && <p className="form-error">{error}</p>}
      {!loading && activity.length === 0 && <p className="muted">No activity recorded yet.</p>}
      <div className="activity-list">
        {activity.map((a) => (
          <div key={a.id} className="activity-row">
            <span>
              <strong>{a.username || 'system'}</strong> {ACTION_LABELS[a.action] || a.action}
              {a.targetName && <> "{a.targetName}"</>}
              {a.details && <span className="muted"> ({a.details})</span>}
            </span>
            <span className="muted small">{timeAgo(a.timestamp)}</span>
          </div>
        ))}
      </div>
    </Modal>
  );
}
