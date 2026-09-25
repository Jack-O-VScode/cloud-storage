import React, { useCallback, useEffect, useState } from 'react';
import Modal from './Modal.jsx';
import { api } from '../api.js';
import { formatBytes, formatDate } from '../utils/format.js';

export default function VersionHistoryModal({ node, onChanged, onClose }) {
  const [versions, setVersions] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');
  const [current, setCurrent] = useState(node);

  const load = useCallback(() => {
    api
      .listVersions(current.id)
      .then((data) => setVersions(data.versions))
      .catch((e) => setError(e.message));
  }, [current.id]);

  useEffect(() => {
    load();
  }, [load]);

  const restore = async (versionId) => {
    setBusyId(versionId);
    setError('');
    try {
      const { item } = await api.restoreVersion(current.id, versionId);
      setCurrent(item);
      onChanged?.();
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Modal
      title={`Version history — ${node.name}`}
      onClose={onClose}
      footer={
        <button className="btn" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="version-row version-row-current">
        <div>
          <strong>Current version</strong>
          <p className="muted small">
            {formatBytes(current.size)} · {formatDate(current.updatedAt)}
          </p>
        </div>
        <a className="btn" href={api.downloadUrl(current.id)}>
          Download
        </a>
      </div>

      {error && <p className="form-error">{error}</p>}

      {versions === null && <p className="muted">Loading…</p>}
      {versions?.length === 0 && <p className="muted small">No earlier versions - upload a new version to start keeping history.</p>}
      {versions?.map((v) => (
        <div key={v.id} className="version-row">
          <div>
            <p className="muted small">
              {formatBytes(v.size)} · {formatDate(v.createdAt)}
            </p>
          </div>
          <div className="version-row-actions">
            <a className="btn" href={api.versionDownloadUrl(current.id, v.id)}>
              Download
            </a>
            <button className="btn btn-primary" onClick={() => restore(v.id)} disabled={busyId === v.id}>
              Restore
            </button>
          </div>
        </div>
      ))}
    </Modal>
  );
}
