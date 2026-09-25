import React, { useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { formatBytes, formatDate, mimeCategory } from '../utils/format.js';

const DRAG_MIME = 'application/x-cloudstorage-node';

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
  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  return (
    <div className="row-menu" ref={ref}>
      {!trashView && (
        <>
          <button onClick={() => actions.download(node)}>Download</button>
          <button onClick={() => actions.copyShareLink(node)}>Copy share link</button>
          {canNativeShare && <button onClick={() => actions.nativeShare(node)}>Share via…</button>}
          <button onClick={() => actions.share(node)}>Share settings</button>
          <button onClick={() => actions.toggleStar(node)}>
            {node.starred ? 'Remove from Starred' : 'Add to Starred'}
          </button>
          {node.type === 'file' && (
            <>
              <button onClick={() => actions.uploadVersion(node)}>Upload new version</button>
              <button onClick={() => actions.versionHistory(node)}>
                Version history{node.versionCount ? ` (${node.versionCount})` : ''}
              </button>
            </>
          )}
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

function SortHeader({ label, field, sortBy, sortDir, onSortChange }) {
  const active = sortBy === field;
  return (
    <button className="sort-header" onClick={() => onSortChange(field)}>
      {label}
      {active && <span className="sort-arrow">{sortDir === 'asc' ? '▲' : '▼'}</span>}
    </button>
  );
}

export default function ItemsList({
  items,
  trashView,
  onOpen,
  actions,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
  sortBy,
  sortDir,
  onSortChange,
  onMoveItem,
}) {
  const [openMenu, setOpenMenu] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);

  if (items.length === 0) {
    return <div className="empty-state">{trashView ? 'Trash is empty.' : 'This folder is empty.'}</div>;
  }

  const allSelected = items.length > 0 && items.every((i) => selectedIds.has(i.id));
  const canDrag = !trashView && Boolean(onMoveItem);

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
          {onSortChange ? (
            <SortHeader label="Name" field="name" sortBy={sortBy} sortDir={sortDir} onSortChange={onSortChange} />
          ) : (
            <span>Name</span>
          )}
        </span>
        {onSortChange ? (
          <SortHeader label="Size" field="size" sortBy={sortBy} sortDir={sortDir} onSortChange={onSortChange} />
        ) : (
          <span>Size</span>
        )}
        {onSortChange ? (
          <SortHeader
            label="Modified"
            field="updatedAt"
            sortBy={sortBy}
            sortDir={sortDir}
            onSortChange={onSortChange}
          />
        ) : (
          <span>Modified</span>
        )}
        <span />
      </div>
      {items.map((item) => (
        <div
          key={item.id}
          className={`items-row ${selectedIds.has(item.id) ? 'selected' : ''} ${
            dragOverId === item.id ? 'drag-over' : ''
          }`}
          draggable={canDrag}
          onDoubleClick={() => !trashView && onOpen(item)}
          onDragStart={(e) => {
            if (!canDrag) return;
            e.dataTransfer.setData(DRAG_MIME, item.id);
            e.dataTransfer.effectAllowed = 'move';
          }}
          onDragOver={(e) => {
            if (!canDrag || item.type !== 'folder') return;
            if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
            e.preventDefault();
            e.stopPropagation();
          }}
          onDragEnter={(e) => {
            if (!canDrag || item.type !== 'folder') return;
            if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
            e.preventDefault();
            e.stopPropagation();
            setDragOverId(item.id);
          }}
          onDragLeave={() => setDragOverId((cur) => (cur === item.id ? null : cur))}
          onDrop={(e) => {
            if (!canDrag || item.type !== 'folder') return;
            if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
            e.preventDefault();
            e.stopPropagation();
            setDragOverId(null);
            const draggedId = e.dataTransfer.getData(DRAG_MIME);
            if (draggedId && draggedId !== item.id) onMoveItem(draggedId, item.id);
          }}
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
            {item.contentMatch && <span className="badge">content match</span>}
            {!trashView && (
              <button
                className={`star-toggle ${item.starred ? 'starred' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  actions.toggleStar(item);
                }}
                aria-label={item.starred ? 'Remove from starred' : 'Add to starred'}
                title={item.starred ? 'Remove from starred' : 'Add to starred'}
              >
                {item.starred ? '★' : '☆'}
              </button>
            )}
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
