import React, { useEffect, useState } from 'react';
import Modal from './Modal.jsx';
import Icon from './Icon.jsx';
import { api } from '../api.js';

// `excludeIds` hides those folders from the destination picker - used both
// to stop a single folder being moved into itself, and (for a bulk move)
// to hide every folder currently selected so you can't drop a selection
// inside one of its own members.
export default function MoveModal({ title, excludeIds, onMove, onCancel }) {
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
        setFolders(data.items.filter((n) => n.type === 'folder' && !excludeIds.has(n.id)));
        setBreadcrumb(data.breadcrumb);
      })
      .catch((e) => setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [parentId, excludeIds]);

  const currentName = breadcrumb.length ? breadcrumb[breadcrumb.length - 1].name : 'My Drive';

  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => onMove(parentId)}>
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
