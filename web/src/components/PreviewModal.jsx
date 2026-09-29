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

export default function PreviewModal({ node, onClose }) {
  const category = mimeCategory(node);
  // A short-lived token appended to the media/download URLs, so an OS-level
  // save flow (notably iOS Safari's native "Save Video" on the <video>
  // player) can fetch the file on its own, outside the page's cookie jar,
  // instead of silently failing or saving an unauthenticated error response.
  const [mediaToken, setMediaToken] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getMediaToken(node.id)
      .then(({ token }) => !cancelled && setMediaToken(token))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [node.id]);

  const withToken = (base) => (mediaToken ? `${base}${base.includes('?') ? '&' : '?'}token=${mediaToken}` : base);
  const url = withToken(api.previewUrl(node.id));
  const downloadHref = withToken(api.downloadUrl(node.id));

  const needsToken = category === 'image' || category === 'video' || category === 'audio' || category === 'pdf';

  let body;
  if (needsToken && !mediaToken) {
    // Held back until the token resolves (usually near-instant) rather
    // than starting playback on a cookie-only URL and then swapping the
    // `src` out from under it once the token arrives, which would restart
    // whatever had already started playing.
    body = <p className="muted">Loading preview…</p>;
  } else if (category === 'image') {
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
          <a className="btn" href={downloadHref}>
            Download
          </a>
          <button className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      {body}
    </Modal>
  );
}
