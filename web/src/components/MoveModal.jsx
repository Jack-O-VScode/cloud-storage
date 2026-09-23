import React, { useEffect, useState } from 'react';
import Modal from './Modal.jsx';
import Icon from './Icon.jsx';
import { api } from '../api.js';

export default function MoveModal({ node, onMove, onCancel }) {
  const [parentId, setParentId] = useState('root');
  const [breadcrumb, setBreadcrumb] = useState([]);
  const [folders, setFolders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .listNodes(parentId)
      .then((data) => {
        if (cancelled) return;
        setFolders(data.items.filter((n) => n.type === 'folder' && n.id !== node.id));
        setBreadcrumb(data.breadcrumb);
      })
      .catch((e) => setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [parentId, node.id]);

  const currentName = breadcrumb.length ? breadcrumb[breadcrumb.length - 1].name : 'My Drive';

  return (
    <Modal
      title={`Move "${node.name}"`}
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={parentId === node.parentId}
            onClick={() => onMove(parentId)}
          >
            Move here
          </button>
        </>
      }
    >
      <div className="move-breadcrumb">
        <button className="link-btn" onClick={() => setParentId('root')}>
          My Drive
        </button>
        {breadcrumb.map((b) => (
          <React.Fragment key={b.id}>
            <span> / </span>
            <button className="link-btn" onClick={() => setParentId(b.id)}>
              {b.name}
            </button>
          </React.Fragment>
        ))}
      </div>
      <div className="move-list">
        {loading && <p className="muted">Loading…</p>}
        {error && <p className="form-error">{error}</p>}
        {!loading && folders.length === 0 && <p className="muted">No subfolders here.</p>}
        {folders.map((f) => (
          <button key={f.id} className="move-row" onClick={() => setParentId(f.id)}>
            <Icon category="folder" size={18} />
            <span>{f.name}</span>
            <span className="move-row-arrow">›</span>
          </button>
        ))}
      </div>
      <p className="muted move-current">Currently viewing: {currentName}</p>
    </Modal>
  );
}
