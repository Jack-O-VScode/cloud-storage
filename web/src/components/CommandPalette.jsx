import React, { useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { mimeCategory } from '../utils/format.js';

// A Ctrl/Cmd+K quick-jump: static app commands (new folder, go to Trash,
// open Settings, ...) plus a debounced search across the user's files,
// merged into one keyboard-navigable list.
export default function CommandPalette({ open, onClose, commands, onSearch, onSelectFile }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef(null);
  const debounceRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setResults([]);
    setActiveIndex(0);
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setResults([]);
      return undefined;
    }
    debounceRef.current = setTimeout(() => {
      onSearch(query)
        .then(setResults)
        .catch(() => setResults([]));
    }, 200);
    return () => clearTimeout(debounceRef.current);
  }, [query, open, onSearch]);

  if (!open) return null;

  const q = query.trim().toLowerCase();
  const filteredCommands = q ? commands.filter((c) => c.label.toLowerCase().includes(q)) : commands;
  const items = [
    ...filteredCommands.map((c) => ({ kind: 'command', ...c })),
    ...results.map((node) => ({ kind: 'file', node })),
  ];

  const runItem = (item) => {
    if (!item) return;
    if (item.kind === 'command') item.run();
    else onSelectFile(item.node);
    onClose();
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(items.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runItem(items[activeIndex]);
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Search files or run a command…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={onKeyDown}
        />
        <div className="palette-list">
          {items.length === 0 && <div className="palette-empty muted">No matches.</div>}
          {items.map((item, i) => (
            <button
              key={item.kind === 'command' ? item.id : item.node.id}
              type="button"
              className={`palette-row ${i === activeIndex ? 'active' : ''}`}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => runItem(item)}
            >
              {item.kind === 'command' ? (
                <>
                  <span className="palette-row-label">{item.label}</span>
                  {item.hint && <span className="muted small">{item.hint}</span>}
                </>
              ) : (
                <>
                  <Icon category={mimeCategory(item.node)} size={16} />
                  <span className="palette-row-label">{item.node.name}</span>
                </>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
