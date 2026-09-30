import React, { useEffect, useState } from 'react';
import Modal from './Modal.jsx';
import { api } from '../api.js';
import { mimeCategory, formatBytes } from '../utils/format.js';

const TEXT_PREVIEW_LIMIT = 200 * 1024; // 200KB - past this, just offer a download

function TextPreview({ node }) {
  const [text, setText] = useState(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetch(api.previewUrl(node.id), { credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) throw new Error('Failed to load file');
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let out = '';
        let bytes = 0;
        let didTruncate = false;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > TEXT_PREVIEW_LIMIT) {
            didTruncate = true;
            reader.cancel();
            break;
          }
          out += decoder.decode(value, { stream: true });
        }
        if (cancelled) return;
        setText(out);
        setTruncated(didTruncate);
      })
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [node.id]);

  if (error) return <p className="form-error">{error}</p>;
  if (text === null) return <p className="muted">Loading…</p>;
  return (
    <>
      <pre className="preview-text">{text}</pre>
      {truncated && <p className="muted small">File is larger than the preview limit — download to see the rest.</p>}
    </>
  );
}

// `siblings` (optional) are the other files in the list the preview was
// opened from - arrow keys / the ‹ › buttons step through them, so a
// folder of photos can be flicked through without closing the preview.
export default function PreviewModal({ node, siblings = [], onNavigate, onClose }) {
  const category = mimeCategory(node);
  const url = api.previewUrl(node.id);
  const index = siblings.findIndex((s) => s.id === node.id);
  const prev = index > 0 ? siblings[index - 1] : null;
  const next = index >= 0 && index < siblings.length - 1 ? siblings[index + 1] : null;

  useEffect(() => {
    if (!onNavigate) return undefined;
    const onKey = (e) => {
      if (e.target.closest?.('input, textarea, select, video, audio')) return;
      if (e.key === 'ArrowLeft' && prev) onNavigate(prev);
      if (e.key === 'ArrowRight' && next) onNavigate(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prev, next, onNavigate]);

  let body;
  if (category === 'image') {
    body = <img className="preview-media" src={url} alt={node.name} />;
  } else if (category === 'video') {
    body = (
      <video className="preview-media" src={url} controls autoPlay>
        Your browser can't play this video.
      </video>
    );
  } else if (category === 'audio') {
    body = <audio className="preview-audio" src={url} controls autoPlay />;
  } else if (category === 'pdf') {
    body = <iframe className="preview-frame" src={url} title={node.name} />;
  } else if (category === 'code') {
    body = <TextPreview node={node} />;
  } else {
    body = (
      <div className="preview-fallback">
        <p className="muted">No in-browser preview for this file type.</p>
        <p className="muted small">{formatBytes(node.size)}</p>
      </div>
    );
  }

  return (
    <Modal
      title={node.name}
      onClose={onClose}
      width={category === 'image' || category === 'video' ? 720 : 560}
      footer={
        <>
          {onNavigate && siblings.length > 1 && (
            <span className="preview-nav">
              <button className="btn" onClick={() => prev && onNavigate(prev)} disabled={!prev} aria-label="Previous file">
                ‹
              </button>
              <span className="muted small">
                {index + 1} / {siblings.length}
              </span>
              <button className="btn" onClick={() => next && onNavigate(next)} disabled={!next} aria-label="Next file">
                ›
              </button>
            </span>
          )}
          <a className="btn" href={api.downloadUrl(node.id)}>
            Download
          </a>
          <button className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div key={node.id}>{body}</div>
    </Modal>
  );
}
