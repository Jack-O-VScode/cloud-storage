import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import Modal from './Modal.jsx';
import { api } from '../api.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const EXPIRY_OPTIONS = [
  { value: 'keep', label: 'Keep current expiry' },
  { value: 'never', label: 'Never expires' },
  { value: String(HOUR), label: '1 hour' },
  { value: String(DAY), label: '1 day' },
  { value: String(7 * DAY), label: '7 days' },
  { value: String(30 * DAY), label: '30 days' },
];

function formatExpiry(ts) {
  if (!ts) return 'Never expires';
  return `Expires ${new Date(ts).toLocaleString()}`;
}

export default function ShareModal({ node, onChanged, onClose }) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [shareToken, setShareToken] = useState(node.shareToken || null);
  const [expiresAt, setExpiresAt] = useState(node.shareExpiresAt || null);
  const [passwordProtected, setPasswordProtected] = useState(node.sharePasswordProtected || false);
  const [uploadEnabled, setUploadEnabled] = useState(node.shareUploadEnabled || false);

  const [expiryChoice, setExpiryChoice] = useState(shareToken ? 'keep' : 'never');
  const [password, setPassword] = useState('');
  const [removePassword, setRemovePassword] = useState(false);
  const [error, setError] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState(null);

  const link = shareToken ? `${window.location.origin}/s/${shareToken}` : null;

  useEffect(() => {
    if (!link) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(link, { margin: 1, width: 220 })
      .then((url) => !cancelled && setQrDataUrl(url))
      .catch(() => !cancelled && setQrDataUrl(null));
    return () => {
      cancelled = true;
    };
  }, [link]);

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const body = {};
      if (expiryChoice !== 'keep') {
        body.expiresInMs = expiryChoice === 'never' ? null : Number(expiryChoice);
      }
      if (removePassword) body.password = '';
      else if (password) body.password = password;
      if (node.type === 'folder') body.uploadEnabled = uploadEnabled;

      const { shareToken: token, item } = await api.share(node.id, body);
      setShareToken(token);
      setExpiresAt(item.shareExpiresAt);
      setPasswordProtected(item.sharePasswordProtected);
      setUploadEnabled(item.shareUploadEnabled);
      setExpiryChoice('keep');
      setPassword('');
      setRemovePassword(false);
      onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    setBusy(true);
    try {
      await api.unshare(node.id);
      setShareToken(null);
      setExpiresAt(null);
      setPasswordProtected(false);
      setUploadEnabled(false);
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
      {!shareToken && (
        <p className="muted">
          {node.type === 'folder'
            ? 'Anyone with the link will be able to browse and download this folder.'
            : 'Anyone with the link will be able to view and download this file.'}
        </p>
      )}

      {shareToken && (
        <>
          <div className="share-link-row">
            <input className="text-input" readOnly value={link} onFocus={(e) => e.target.select()} />
            <button className="btn" onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="muted small">{formatExpiry(expiresAt)}</p>
          {qrDataUrl && (
            <div className="share-qr">
              <img src={qrDataUrl} alt="QR code for share link" width={160} height={160} />
            </div>
          )}
        </>
      )}

      <hr className="divider" />

      {node.type === 'folder' && (
        <label className="checkbox-row">
          <input type="checkbox" checked={uploadEnabled} onChange={(e) => setUploadEnabled(e.target.checked)} />
          Let visitors upload files into this folder
        </label>
      )}

      <label className="field-label">Expiry</label>
      <select className="text-input" value={expiryChoice} onChange={(e) => setExpiryChoice(e.target.value)}>
        {EXPIRY_OPTIONS.filter((o) => o.value !== 'keep' || shareToken).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      {passwordProtected && !removePassword && (
        <>
          <p className="muted small">This link is password protected.</p>
          <label className="checkbox-row">
            <input type="checkbox" checked={removePassword} onChange={(e) => setRemovePassword(e.target.checked)} />
            Remove password protection
          </label>
        </>
      )}
      {!removePassword && (
        <>
          <label className="field-label">{passwordProtected ? 'Change password' : 'Password (optional)'}</label>
          <input
            className="text-input"
            type="password"
            placeholder={passwordProtected ? 'Leave blank to keep current password' : 'No password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </>
      )}

      {error && <p className="form-error">{error}</p>}

      <button className="btn btn-primary btn-block" onClick={submit} disabled={busy}>
        {shareToken ? 'Update link' : 'Create share link'}
      </button>

      {shareToken && (
        <button className="btn btn-danger" style={{ marginTop: 10 }} onClick={revoke} disabled={busy}>
          Revoke link
        </button>
      )}
    </Modal>
  );
}
