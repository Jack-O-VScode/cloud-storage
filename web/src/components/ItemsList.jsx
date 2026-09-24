import React, { useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { formatBytes, formatDate, mimeCategory } from '../utils/format.js';

function useOutsideClose(ref, onClose) {
  useEffect(() => {
    function handler(e) {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [ref, onClose]);
}

function RowMenu({ node, trashView, actions, onClose }) {
  const ref = useRef(null);
  useOutsideClose(ref, onClose);

  return (
    <div className="row-menu" ref={ref}>
      {!trashView && (
        <>
          <button onClick={() => actions.download(node)}>Download</button>
          <button onClick={() => actions.share(node)}>Share link</button>
          <button onClick={() => actions.rename(node)}>Rename</button>
          <button onClick={() => actions.move(node)}>Move</button>
          <button className="danger" onClick={() => actions.trash(node)}>
            Move to trash
          </button>
        </>
      )}
      {trashView && (
        <>
          <button onClick={() => actions.restore(node)}>Restore</button>
          <button className="danger" onClick={() => actions.deleteForever(node)}>
            Delete forever
          </button>
        </>
      )}
    </div>
  );
}

function RowIcon({ item }) {
  const category = mimeCategory(item);
  if (category === 'image') {
    return <img className="items-thumb" src={api.previewUrl(item.id)} loading="lazy" alt="" />;
  }
  return <Icon category={category} />;
}

export default function ItemsList({ items, trashView, onOpen, actions, selectedIds, onToggleSelect, onToggleSelectAll }) {
  const [openMenu, setOpenMenu] = useState(null);

  if (items.length === 0) {
    return <div className="empty-state">{trashView ? 'Trash is empty.' : 'This folder is empty.'}</div>;
  }

  const allSelected = items.length > 0 && items.every((i) => selectedIds.has(i.id));

  return (
    <div className="items-table">
      <div className="items-header">
        <span className="items-name">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={onToggleSelectAll}
            aria-label="Select all"
          />
          <span>Name</span>
        </span>
        <span>Size</span>
        <span>Modified</span>
        <span />
      </div>
      {items.map((item) => (
        <div
          key={item.id}
          className={`items-row ${selectedIds.has(item.id) ? 'selected' : ''}`}
          onDoubleClick={() => !trashView && onOpen(item)}
        >
          <span className="items-name">
            <input
              type="checkbox"
              checked={selectedIds.has(item.id)}
              onChange={() => onToggleSelect(item.id)}
              onClick={(e) => e.stopPropagation()}
            />
            <RowIcon item={item} />
            <span className="items-name-text">{item.name}</span>
            {item.shared && <span className="badge">shared</span>}
          </span>
          <span className="muted">{item.type === 'file' ? formatBytes(item.size) : '—'}</span>
          <span className="muted">{formatDate(item.trashedAt || item.updatedAt)}</span>
          <span className="items-actions">
            <button className="icon-btn" onClick={() => setOpenMenu(openMenu === item.id ? null : item.id)}>
              ⋮
            </button>
            {openMenu === item.id && (
              <RowMenu
                node={item}
                trashView={trashView}
                actions={actions}
                onClose={() => setOpenMenu(null)}
              />
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
