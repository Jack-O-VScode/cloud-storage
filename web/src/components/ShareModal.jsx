import React, { useState } from 'react';
import Modal from './Modal.jsx';
import { api } from '../api.js';

export default function ShareModal({ node, onChanged, onClose }) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [shareToken, setShareToken] = useState(node.shareToken || null);

  const link = shareToken ? `${window.location.origin}/s/${shareToken}` : null;

  const enable = async () => {
    setBusy(true);
    try {
      const { shareToken } = await api.share(node.id);
      setShareToken(shareToken);
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    setBusy(true);
    try {
      await api.unshare(node.id);
      setShareToken(null);
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!link) return;
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Modal
      title={`Share "${node.name}"`}
      onClose={onClose}
      footer={
        <button className="btn" onClick={onClose}>
          Done
        </button>
      }
    >
      {!link && (
        <>
          <p className="muted">Anyone with the link will be able to view and download this file.</p>
          <button className="btn btn-primary" onClick={enable} disabled={busy}>
            Create share link
          </button>
        </>
      )}
      {link && (
        <>
          <div className="share-link-row">
            <input className="text-input" readOnly value={link} onFocus={(e) => e.target.select()} />
            <button className="btn" onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <button className="btn btn-danger" style={{ marginTop: 12 }} onClick={revoke} disabled={busy}>
            Revoke link
          </button>
        </>
      )}
    </Modal>
  );
}
