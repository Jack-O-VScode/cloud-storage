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

// Shares an arbitrary multi-select as one link, distinct from ShareModal
// which shares exactly one node's own subtree.
export default function BundleShareModal({ nodeIds, onClose }) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [bundle, setBundle] = useState(null);
  const [qrDataUrl, setQrDataUrl] = useState(null);
  const [expiryChoice, setExpiryChoice] = useState('never');
  const [password, setPassword] = useState('');
  const [removePassword, setRemovePassword] = useState(false);
  const [error, setError] = useState('');

  const link = bundle ? `${window.location.origin}/s/${bundle.token}` : null;
  const count = nodeIds.length;

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

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const { bundle: b } = await api.shareBundle(nodeIds);
      setBundle(b);
      setExpiryChoice('keep');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const update = async () => {
    setBusy(true);
    setError('');
    try {
      const body = {};
      if (expiryChoice !== 'keep') {
        body.expiresInMs = expiryChoice === 'never' ? null : Number(expiryChoice);
      }
      if (removePassword) body.password = '';
      else if (password) body.password = password;

      const { bundle: b } = await api.patchShareBundle(bundle.id, body);
      setBundle(b);
      setExpiryChoice('keep');
      setPassword('');
      setRemovePassword(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    setBusy(true);
    try {
      await api.deleteShareBundle(bundle.id);
      setBundle(null);
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
      title={`Share ${count} item${count === 1 ? '' : 's'} as one link`}
      onClose={onClose}
      footer={
        <button className="btn" onClick={onClose}>
          Done
        </button>
      }
    >
      {!bundle && (
        <>
          <p className="muted">Anyone with the link will be able to browse and download everything in this selection.</p>
          {error && <p className="form-error">{error}</p>}
          <button className="btn btn-primary btn-block" onClick={create} disabled={busy}>
            Create share link
          </button>
        </>
      )}

      {bundle && (
        <>
          <div className="share-link-row">
            <input className="text-input" readOnly value={link} onFocus={(e) => e.target.select()} />
            <button className="btn" onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="muted small">{formatExpiry(bundle.expiresAt)}</p>
          {qrDataUrl && (
            <div className="share-qr">
              <img src={qrDataUrl} alt="QR code for share link" width={160} height={160} />
            </div>
          )}

          <hr className="divider" />

          <label className="field-label">Expiry</label>
          <select className="text-input" value={expiryChoice} onChange={(e) => setExpiryChoice(e.target.value)}>
            {EXPIRY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>

          {bundle.passwordProtected && !removePassword && (
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
              <label className="field-label">{bundle.passwordProtected ? 'Change password' : 'Password (optional)'}</label>
              <input
                className="text-input"
                type="password"
                placeholder={bundle.passwordProtected ? 'Leave blank to keep current password' : 'No password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </>
          )}

          {error && <p className="form-error">{error}</p>}

          <button className="btn btn-primary btn-block" onClick={update} disabled={busy}>
            Update link
          </button>
          <button className="btn btn-danger" style={{ marginTop: 10 }} onClick={revoke} disabled={busy}>
            Revoke link
          </button>
        </>
      )}
    </Modal>
  );
}
