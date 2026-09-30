import React, { useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { formatBytes, formatDate, mimeCategory } from '../utils/format.js';

const DRAG_MIME = 'application/x-cloudstorage-node';

// Phones/tablets have no double-click - a single tap opens instead (the
// checkbox and ⋮ menu still select / show actions).
const isTouchDevice = () => typeof window !== 'undefined' && window.matchMedia?.('(hover: none)').matches;

function useOutsideClose(ref, onClose) {
  useEffect(() => {
    function handler(e) {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    }
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, [ref, onClose]);
}

function LinkGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5" strokeLinecap="round" />
      <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5" strokeLinecap="round" />
    </svg>
  );
}

function PeopleGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5" strokeLinecap="round" />
      <path d="M16 4.8a3.3 3.3 0 0 1 0 6.4M18.5 14.8c1.6.8 2.6 2.5 3 5.2" strokeLinecap="round" />
    </svg>
  );
}

// Small markers after a name showing how an item is shared: a link icon
// for a public link, people + count for specific people, or whose it is
// when it belongs to someone else.
function ShareMarkers({ item }) {
  if (item.access && item.access !== 'owner') {
    return item.ownerUsername ? <span className="badge">{item.ownerUsername}'s</span> : null;
  }
  const hasLink = item.shareToken && !item.shareExpired;
  return (
    <>
      {(hasLink || item.inLinkBundle) && (
        <span
          className="share-marker"
          title={hasLink ? 'Anyone with the link can open this' : 'Included in a multi-item link'}
        >
          <LinkGlyph />
        </span>
      )}
      {item.sharedWithCount > 0 && (
        <span
          className="share-marker"
          title={`Shared with ${item.sharedWithCount} ${item.sharedWithCount === 1 ? 'person' : 'people'}`}
        >
          <PeopleGlyph />
          {item.sharedWithCount}
        </span>
      )}
    </>
  );
}

function RowMenu({ node, trashView, actions, onClose, position }) {
  const ref = useRef(null);
  useOutsideClose(ref, onClose);
  const access = node.access || 'owner';
  const isOwner = access === 'owner';
  const canEdit = isOwner || access === 'edit';
  // Every entry closes the menu once chosen.
  const act = (fn) => () => {
    onClose();
    fn(node);
  };

  return (
    <div className="row-menu" ref={ref} role="menu" style={position}>
      {!trashView && (
        <>
          <button onClick={act(actions.open)}>{node.type === 'folder' ? 'Open' : 'Preview'}</button>
          <button onClick={act(actions.download)}>Download</button>
          {isOwner && (
            <>
              <div className="row-menu-sep" />
              <button onClick={act(actions.share)}>Share…</button>
              <button onClick={act(actions.copyLink)}>{node.shareToken && !node.shareExpired ? 'Copy link' : 'Get link…'}</button>
            </>
          )}
          <div className="row-menu-sep" />
          {isOwner && (
            <button onClick={act(actions.toggleStar)}>{node.starred ? 'Remove from Starred' : 'Add to Starred'}</button>
          )}
          {canEdit && <button onClick={act(actions.rename)}>Rename</button>}
          {isOwner && <button onClick={act(actions.move)}>Move</button>}
          {node.type === 'file' && canEdit && (
            <>
              <button onClick={act(actions.uploadVersion)}>Upload new version</button>
              <button onClick={act(actions.versionHistory)}>
                Version history{node.versionCount ? ` (${node.versionCount})` : ''}
              </button>
            </>
          )}
          <button onClick={act(actions.comments)}>Comments{node.commentCount ? ` (${node.commentCount})` : ''}</button>
          {node.grantId && (
            <button onClick={act(actions.leaveShare)}>Remove from Shared with me</button>
          )}
          {canEdit && (
            <>
              <div className="row-menu-sep" />
              <button className="danger" onClick={act(actions.trash)}>
                Move to trash
              </button>
            </>
          )}
        </>
      )}
      {trashView && (
        <>
          <button onClick={act(actions.restore)}>Restore</button>
          <button className="danger" onClick={act(actions.deleteForever)}>
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
    return <img className="items-thumb" src={api.thumbnailUrl(item.id)} loading="lazy" alt="" />;
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
  emptyMessage,
}) {
  const [openMenu, setOpenMenu] = useState(null); // { id, position }
  const [dragOverId, setDragOverId] = useState(null);

  // The menu floats (position: fixed) so a scrolling list can't clip it -
  // which also means it has to go away once the list scrolls under it.
  useEffect(() => {
    if (!openMenu) return undefined;
    const close = () => setOpenMenu(null);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [openMenu]);

  if (items.length === 0) {
    return <div className="empty-state">{emptyMessage || (trashView ? 'Trash is empty.' : 'This folder is empty.')}</div>;
  }

  const allSelected = items.length > 0 && items.every((i) => selectedIds.has(i.id));
  const canDragItem = (item) => !trashView && Boolean(onMoveItem) && (item.access || 'owner') !== 'view' && (item.access || 'owner') !== 'upload';
  const touch = isTouchDevice();

  const toggleMenu = (e, item) => {
    e.stopPropagation();
    if (openMenu?.id === item.id) return setOpenMenu(null);
    // Opens upwards when there isn't room below (last rows, small screens).
    const rect = e.currentTarget.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const up = spaceBelow < 360 && rect.top > spaceBelow;
    const right = Math.max(8, window.innerWidth - rect.right);
    setOpenMenu({
      id: item.id,
      position: up
        ? { bottom: window.innerHeight - rect.top + 4, right, maxHeight: rect.top - 12 }
        : { top: rect.bottom + 4, right, maxHeight: spaceBelow - 12 },
    });
  };

  const header = (label, field) =>
    onSortChange ? <SortHeader label={label} field={field} sortBy={sortBy} sortDir={sortDir} onSortChange={onSortChange} /> : <span>{label}</span>;

  return (
    <div className="items-table">
      <div className="items-header">
        <span className="items-name">
          <input type="checkbox" checked={allSelected} onChange={onToggleSelectAll} aria-label="Select all" />
          {header('Name', 'name')}
        </span>
        {header('Size', 'size')}
        {header(trashView ? 'Deleted' : 'Modified', 'updatedAt')}
        <span />
      </div>
      {items.map((item) => {
        const draggable = canDragItem(item);
        return (
          <div
            key={item.id}
            className={`items-row ${selectedIds.has(item.id) ? 'selected' : ''} ${dragOverId === item.id ? 'drag-over' : ''}`}
            draggable={draggable && !touch}
            onDoubleClick={() => !trashView && !touch && onOpen(item)}
            onClick={(e) => {
              if (!touch || trashView) return;
              if (e.target.closest('input, button, .row-menu, a')) return;
              onOpen(item);
            }}
            onDragStart={(e) => {
              if (!draggable) return;
              e.dataTransfer.setData(DRAG_MIME, item.id);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(e) => {
              if (!onMoveItem || item.type !== 'folder') return;
              if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
              e.preventDefault();
              e.stopPropagation();
            }}
            onDragEnter={(e) => {
              if (!onMoveItem || item.type !== 'folder') return;
              if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
              e.preventDefault();
              e.stopPropagation();
              setDragOverId(item.id);
            }}
            onDragLeave={() => setDragOverId((cur) => (cur === item.id ? null : cur))}
            onDrop={(e) => {
              if (!onMoveItem || item.type !== 'folder') return;
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
                aria-label={`Select ${item.name}`}
              />
              <RowIcon item={item} />
              <span className="items-name-text" title={item.name}>
                {item.name}
              </span>
              {!trashView && <ShareMarkers item={item} />}
              {item.contentMatch && <span className="badge">content match</span>}
              {!trashView && (item.access || 'owner') === 'owner' && (
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
              <button className="icon-btn" onClick={(e) => toggleMenu(e, item)} aria-label={`Actions for ${item.name}`}>
                ⋮
              </button>
              {openMenu?.id === item.id && (
                <RowMenu
                  node={item}
                  trashView={trashView}
                  actions={actions}
                  position={openMenu.position}
                  onClose={() => setOpenMenu(null)}
                />
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
