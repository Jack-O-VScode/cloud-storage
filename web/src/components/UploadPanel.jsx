import React, { useState, useSyncExternalStore } from 'react';
import {
  subscribe,
  getSnapshot,
  cancel,
  cancelAll,
  retry,
  retryAllFailed,
  clearFinished,
} from '../uploads/uploadManager.js';
import { formatBytes, formatSpeed, formatDuration } from '../utils/format.js';

function statusText(t) {
  switch (t.status) {
    case 'queued':
      return 'Waiting…';
    case 'uploading':
      return t.size ? `${formatBytes(t.loaded)} of ${formatBytes(t.size)}` : 'Uploading…';
    case 'finishing':
      return 'Finishing…';
    case 'done':
      if (t.replaced) return 'Replaced (old copy kept in version history)';
      if (t.finalName && t.finalName !== t.name) return `Saved as “${t.finalName}”`;
      return 'Done';
    case 'cancelled':
      return 'Cancelled';
    case 'error':
      return t.error || 'Failed';
    default:
      return '';
  }
}

function StatusIcon({ status }) {
  if (status === 'done') return <span className="upload-row-icon ok">✓</span>;
  if (status === 'error') return <span className="upload-row-icon err">!</span>;
  if (status === 'cancelled') return <span className="upload-row-icon muted">–</span>;
  return <span className="upload-row-spinner" aria-hidden="true" />;
}

// Google Drive-style panel pinned to the bottom corner, listing every file
// in the current upload batch with its own progress and cancel/retry.
export default function UploadPanel() {
  const { tasks, stats } = useSyncExternalStore(subscribe, getSnapshot);
  const [collapsed, setCollapsed] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);

  if (!tasks.length || !stats) return null;

  const running = stats.inProgress > 0;
  let title;
  if (running) title = `Uploading ${stats.done + 1 > stats.total ? stats.total : stats.done + 1} of ${stats.total}`;
  else if (stats.failed) title = `${stats.failed} upload${stats.failed > 1 ? 's' : ''} failed`;
  else title = `${stats.done} upload${stats.done === 1 ? '' : 's'} complete`;

  const remaining = stats.totalBytes - stats.loadedBytes;
  const eta = running && stats.bytesPerSecond > 0 && remaining > 0 ? formatDuration(remaining / stats.bytesPerSecond) : null;
  const pct = stats.totalBytes ? Math.min(100, (stats.loadedBytes / stats.totalBytes) * 100) : running ? 0 : 100;

  const close = () => {
    if (running) setConfirmingClose(true);
    else clearFinished();
  };

  return (
    <div className={`upload-panel ${collapsed ? 'collapsed' : ''}`} role="region" aria-label="Uploads">
      <div className="upload-panel-header">
        <div className="upload-panel-title">
          <strong>{title}</strong>
          {running && (
            <span className="muted small">
              {stats.bytesPerSecond > 0 ? formatSpeed(stats.bytesPerSecond) : 'Starting…'}
              {eta && ` · ${eta} left`}
            </span>
          )}
        </div>
        {stats.failed > 0 && !running && (
          <button className="link-btn" onClick={retryAllFailed}>
            Retry all
          </button>
        )}
        <button
          className="icon-btn"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? 'Expand uploads' : 'Collapse uploads'}
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          {collapsed ? '▴' : '▾'}
        </button>
        <button className="icon-btn" onClick={close} aria-label="Close uploads" title="Close">
          ✕
        </button>
      </div>
      {running && (
        <div className="upload-panel-bar">
          <div style={{ width: `${pct}%` }} />
        </div>
      )}
      {confirmingClose && (
        <div className="upload-panel-confirm">
          <span>Cancel the uploads still in progress?</span>
          <button
            className="btn btn-danger"
            onClick={() => {
              cancelAll();
              setConfirmingClose(false);
            }}
          >
            Cancel uploads
          </button>
          <button className="btn" onClick={() => setConfirmingClose(false)}>
            Keep going
          </button>
        </div>
      )}
      {!collapsed && (
        <div className="upload-panel-list">
          {tasks.map((t) => (
            <div key={t.id} className={`upload-row status-${t.status}`}>
              <StatusIcon status={t.status} />
              <div className="upload-row-main">
                <div className="upload-row-name" title={t.name}>
                  {t.name}
                </div>
                <div className={`upload-row-status small ${t.status === 'error' ? 'form-error' : 'muted'}`}>
                  {statusText(t)}
                  {t.targetLabel && t.status !== 'error' ? ` · ${t.targetLabel}` : ''}
                </div>
                {t.status === 'uploading' && t.size > 0 && (
                  <div className="upload-row-bar">
                    <div style={{ width: `${Math.min(100, (t.loaded / t.size) * 100)}%` }} />
                  </div>
                )}
              </div>
              {(t.status === 'queued' || t.status === 'uploading') && (
                <button className="icon-btn" onClick={() => cancel(t.id)} aria-label={`Cancel ${t.name}`} title="Cancel">
                  ✕
                </button>
              )}
              {(t.status === 'error' || t.status === 'cancelled') && (
                <button className="link-btn" onClick={() => retry(t.id)}>
                  Retry
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
