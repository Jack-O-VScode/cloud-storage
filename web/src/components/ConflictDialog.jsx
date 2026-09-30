import React, { useState } from 'react';
import Modal from './Modal.jsx';
import { formatBytes, formatDate } from '../utils/format.js';

// Asks what to do about each upload whose name is already taken where it's
// going: Replace (the existing file's old content is kept in its version
// history), Keep both (the new one is saved as "name (1).ext"), or Skip.
// `conflicts`: [{ index, path, existing, file }]. Resolves via
// onDone(Map<index, 'replace' | 'rename' | 'skip'>), or onCancel() to
// abandon the whole upload.
export default function ConflictDialog({ conflicts, canReplace, onDone, onCancel }) {
  const [position, setPosition] = useState(0);
  const [decisions] = useState(() => new Map());
  const [applyToAll, setApplyToAll] = useState(false);

  const current = conflicts[position];
  const remaining = conflicts.length - position - 1;
  const existingIsFolder = current.existing.type === 'folder';
  const replaceAllowed = canReplace && !existingIsFolder;

  const decide = (action) => {
    const rest = applyToAll ? conflicts.slice(position) : [current];
    for (const c of rest) {
      // "Replace" can't apply to a clash with a folder - keep both instead.
      const effective = action === 'replace' && c.existing.type === 'folder' ? 'rename' : action;
      decisions.set(c.index, effective);
    }
    if (applyToAll || position === conflicts.length - 1) onDone(decisions);
    else {
      setPosition(position + 1);
      setApplyToAll(false);
    }
  };

  const where = current.path.includes('/') ? current.path.split('/').slice(0, -1).join('/') : null;

  return (
    <Modal
      title={conflicts.length > 1 ? `${conflicts.length} items already exist` : 'Item already exists'}
      onClose={onCancel}
      width={480}
      footer={
        <button className="link-btn" onClick={onCancel}>
          Cancel upload
        </button>
      }
    >
      <p>
        <strong>“{current.existing.name}”</strong> is already {where ? <>in “{where}”</> : 'in this folder'}.
        {conflicts.length > 1 && (
          <span className="muted small">
            {' '}
            ({position + 1} of {conflicts.length})
          </span>
        )}
      </p>
      <div className="conflict-compare">
        <div>
          <div className="muted small">Already there</div>
          <div>
            {existingIsFolder ? 'Folder' : formatBytes(current.existing.size)} · {formatDate(current.existing.updatedAt)}
          </div>
        </div>
        <div>
          <div className="muted small">Uploading</div>
          <div>
            {formatBytes(current.file.size)}
            {current.file.lastModified ? ` · ${formatDate(current.file.lastModified)}` : ''}
          </div>
        </div>
      </div>
      <div className="conflict-actions">
        {replaceAllowed && (
          <button className="btn btn-primary" onClick={() => decide('replace')}>
            Replace
            <span className="conflict-hint">Old copy kept in version history</span>
          </button>
        )}
        <button className={`btn ${replaceAllowed ? '' : 'btn-primary'}`} onClick={() => decide('rename')}>
          Keep both
          <span className="conflict-hint">New one saved with (1) added</span>
        </button>
        <button className="btn" onClick={() => decide('skip')}>
          Skip
          <span className="conflict-hint">Don't upload this one</span>
        </button>
      </div>
      {existingIsFolder && canReplace && (
        <p className="muted small">A folder has this name, so it can't be replaced by a file.</p>
      )}
      {remaining > 0 && (
        <label className="checkbox-row" style={{ marginTop: 14 }}>
          <input type="checkbox" checked={applyToAll} onChange={(e) => setApplyToAll(e.target.checked)} />
          Do this for the {remaining} other conflict{remaining === 1 ? '' : 's'} too
        </label>
      )}
    </Modal>
  );
}
