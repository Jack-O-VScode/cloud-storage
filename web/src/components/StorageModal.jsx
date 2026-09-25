import React from 'react';
import Modal from './Modal.jsx';
import { formatBytes } from '../utils/format.js';

// Mirrors the colors Icon.jsx uses for each file category, so this chart's
// legend matches the icons shown everywhere else in the app.
const CATEGORY_INFO = {
  image: { label: 'Images', color: '#e0714a' },
  video: { label: 'Videos', color: '#8b5cf6' },
  audio: { label: 'Audio', color: '#ec4899' },
  pdf: { label: 'PDFs', color: '#e0454a' },
  archive: { label: 'Archives', color: '#a3852b' },
  doc: { label: 'Documents', color: '#2f6fed' },
  sheet: { label: 'Spreadsheets', color: '#1f9d55' },
  slides: { label: 'Presentations', color: '#e0a72e' },
  code: { label: 'Code & text', color: '#4b5563' },
  file: { label: 'Other', color: '#7c8a99' },
};

export default function StorageModal({ usage, onClose }) {
  const byCategory = usage?.byCategory || {};
  const total = usage?.bytesUsed || 0;
  const rows = Object.entries(byCategory)
    .filter(([, bytes]) => bytes > 0)
    .sort((a, b) => b[1] - a[1]);

  return (
    <Modal
      title="Storage details"
      onClose={onClose}
      footer={
        <button className="btn" onClick={onClose}>
          Close
        </button>
      }
    >
      <p className="muted">
        {formatBytes(total)} used
        {usage?.quotaBytes ? <> of {formatBytes(usage.quotaBytes)}</> : null}
        {usage?.bytesTrashed ? <> · {formatBytes(usage.bytesTrashed)} in trash</> : null}
      </p>

      {rows.length === 0 ? (
        <p className="muted small">No files yet.</p>
      ) : (
        <>
          <div className="storage-stack-bar">
            {rows.map(([cat, bytes]) => (
              <div
                key={cat}
                style={{ width: `${(bytes / total) * 100}%`, background: (CATEGORY_INFO[cat] || CATEGORY_INFO.file).color }}
                title={`${(CATEGORY_INFO[cat] || CATEGORY_INFO.file).label}: ${formatBytes(bytes)}`}
              />
            ))}
          </div>
          <div className="storage-legend">
            {rows.map(([cat, bytes]) => {
              const info = CATEGORY_INFO[cat] || CATEGORY_INFO.file;
              return (
                <div key={cat} className="storage-legend-row">
                  <span className="storage-legend-swatch" style={{ background: info.color }} />
                  <span className="storage-legend-label">{info.label}</span>
                  <span className="muted small">
                    {formatBytes(bytes)} · {((bytes / total) * 100).toFixed(1)}%
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </Modal>
  );
}
