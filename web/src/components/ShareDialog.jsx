import React, { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import Modal from './Modal.jsx';
import { api } from '../api.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const EXPIRY_CHOICES = [
  { value: 'never', label: 'Never expires' },
  { value: String(HOUR), label: 'Expires in 1 hour' },
  { value: String(DAY), label: 'Expires in 1 day' },
  { value: String(7 * DAY), label: 'Expires in 7 days' },
  { value: String(30 * DAY), label: 'Expires in 30 days' },
];

const PERMISSION_LABELS = {
  view: 'Can view',
  upload: 'Can view & add files',
  edit: 'Can edit',
};
const PERMISSION_HINTS = {
  view: 'Open and download only.',
  upload: 'Open, download, and upload new files - but not change or delete anything.',
  edit: 'Also rename, replace and delete (deleted items go to your trash).',
};

function permissionOptions(allFolders) {
  return allFolders ? ['view', 'upload', 'edit'] : ['view', 'edit'];
}

export function linkUrl(token) {
  return `${window.location.origin}/s/${token}`;
}

function formatWhen(ts) {
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// --- People -----------------------------------------------------------------

function PeopleSection({ node, onChanged }) {
  const [grants, setGrants] = useState(null);
  const [username, setUsername] = useState('');
  const [permission, setPermission] = useState('view');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const options = permissionOptions(node.type === 'folder');

  useEffect(() => {
    api
      .listGrantsForNode(node.id)
      .then((d) => setGrants(d.grants))
      .catch((e) => setError(e.message));
  }, [node.id]);

  const run = async (fn) => {
    setBusy(true);
    setError('');
    try {
      const data = await fn();
      if (data?.grants) setGrants(data.grants);
      onChanged?.();
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async (e) => {
    e.preventDefault();
    if (!username.trim()) return;
    if (await run(() => api.createGrant(node.id, username.trim(), permission))) setUsername('');
  };

  return (
    <section className="share-section">
      <h4>People with access</h4>
      {grants === null && !error && <p className="muted small">Loading…</p>}
      {grants?.length === 0 && <p className="muted small">Only you can see this right now.</p>}
      {grants?.map((g) => (
        <div key={g.id} className="access-row">
          <span className="access-avatar" aria-hidden="true">
            {g.granteeUsername.slice(0, 1).toUpperCase()}
          </span>
          <span className="access-row-name">{g.granteeUsername}</span>
          <select
            className="text-input access-row-select"
            value={g.permission}
            onChange={(e) => run(() => api.createGrant(node.id, g.granteeUsername, e.target.value))}
            disabled={busy}
            aria-label={`Access for ${g.granteeUsername}`}
          >
            {options.map((p) => (
              <option key={p} value={p}>
                {PERMISSION_LABELS[p]}
              </option>
            ))}
          </select>
          <button
            className="icon-btn"
            onClick={() => run(() => api.deleteGrant(g.id))}
            disabled={busy}
            aria-label={`Remove ${g.granteeUsername}`}
            title="Remove access"
          >
            ✕
          </button>
        </div>
      ))}
      <form onSubmit={add} className="access-form">
        <input
          className="text-input"
          placeholder="Add someone by username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
        />
        <select
          className="text-input access-row-select"
          value={permission}
          onChange={(e) => setPermission(e.target.value)}
          aria-label="Access level"
        >
          {options.map((p) => (
            <option key={p} value={p}>
              {PERMISSION_LABELS[p]}
            </option>
          ))}
        </select>
        <button className="btn btn-primary" type="submit" disabled={busy || !username.trim()}>
          Add
        </button>
      </form>
      <p className="muted small share-hint">
        {PERMISSION_HINTS[permission]} They'll find it under “Shared with me” when signed in.
      </p>
      {error && <p className="form-error">{error}</p>}
    </section>
  );
}

// Adding a person to several items at once (a multi-selection) - one grant
// per item, since access always lives on individual items.
function BulkPeopleSection({ items, onChanged }) {
  const allFolders = items.every((i) => i.type === 'folder');
  const options = permissionOptions(allFolders);
  const [username, setUsername] = useState('');
  const [permission, setPermission] = useState('view');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const add = async (e) => {
    e.preventDefault();
    const name = username.trim();
    if (!name) return;
    setBusy(true);
    setError('');
    setMessage('');
    const results = await Promise.allSettled(items.map((i) => api.createGrant(i.id, name, permission)));
    const failed = results.filter((r) => r.status === 'rejected');
    setBusy(false);
    onChanged?.();
    if (failed.length === results.length) {
      setError(failed[0].reason.message);
      return;
    }
    setUsername('');
    setMessage(
      failed.length
        ? `Added ${name} to ${results.length - failed.length} of ${results.length} items (${failed[0].reason.message})`
        : `${name} now has access to all ${results.length} items.`
    );
  };

  return (
    <section className="share-section">
      <h4>Give someone access</h4>
      <form onSubmit={add} className="access-form">
        <input
          className="text-input"
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
        />
        <select
          className="text-input access-row-select"
          value={permission}
          onChange={(e) => setPermission(e.target.value)}
          aria-label="Access level"
        >
          {options.map((p) => (
            <option key={p} value={p}>
              {PERMISSION_LABELS[p]}
            </option>
          ))}
        </select>
        <button className="btn btn-primary" type="submit" disabled={busy || !username.trim()}>
          Add
        </button>
      </form>
      <p className="muted small share-hint">
        {PERMISSION_HINTS[permission]} Applies to each of the {items.length} items; manage people per item afterwards.
      </p>
      {message && <p className="small share-ok">{message}</p>}
      {error && <p className="form-error">{error}</p>}
    </section>
  );
}

// --- Link -------------------------------------------------------------------

function LinkSettings({ link, isFolder, busy, onUpdate, onTurnOff }) {
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [qr, setQr] = useState(null);
  const [editingPassword, setEditingPassword] = useState(false);
  const [password, setPassword] = useState('');
  // Shown ticked/unticked straight away rather than after the round trip.
  const [uploadEnabled, setUploadEnabled] = useState(Boolean(link.uploadEnabled));
  useEffect(() => setUploadEnabled(Boolean(link.uploadEnabled)), [link.uploadEnabled]);
  const url = linkUrl(link.token);
  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  useEffect(() => {
    if (!showQr) return undefined;
    let cancelled = false;
    QRCode.toDataURL(url, { margin: 1, width: 220 })
      .then((d) => !cancelled && setQr(d))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [showQr, url]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (e.g. insecure context) - the field is selectable.
    }
  };

  const savePassword = async (e) => {
    e.preventDefault();
    if (!password) return;
    if (await onUpdate({ password })) {
      setPassword('');
      setEditingPassword(false);
    }
  };

  const expiryValue = link.expiresAt ? 'current' : 'never';

  return (
    <>
      <div className="share-link-row">
        <input className="text-input" readOnly value={url} onFocus={(e) => e.target.select()} aria-label="Share link" />
        <button className="btn btn-primary" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className="share-link-tools">
        {canNativeShare && (
          <button className="link-btn" onClick={() => navigator.share({ url }).catch(() => {})}>
            Send…
          </button>
        )}
        <button className="link-btn" onClick={() => setShowQr((v) => !v)}>
          {showQr ? 'Hide QR code' : 'QR code'}
        </button>
      </div>
      {showQr && qr && (
        <div className="share-qr">
          <img src={qr} alt="QR code for the link" width={160} height={160} />
        </div>
      )}
      {link.expired && <p className="form-error small">This link has expired - pick a new expiry to bring it back.</p>}

      <div className="share-setting">
        <label className="field-label" htmlFor="share-expiry">
          Expiry
        </label>
        <select
          id="share-expiry"
          className="text-input"
          value={expiryValue}
          disabled={busy}
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'current') return;
            onUpdate({ expiresInMs: v === 'never' ? null : Number(v) });
          }}
        >
          {link.expiresAt && (
            <option value="current">
              {link.expired ? 'Expired' : 'Expires'} {formatWhen(link.expiresAt)}
            </option>
          )}
          {EXPIRY_CHOICES.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <div className="share-setting">
        <span className="field-label">Password</span>
        {!editingPassword ? (
          <div className="share-password-row">
            <span className="small">{link.passwordProtected ? '🔒 Visitors must enter a password' : 'No password'}</span>
            <button className="link-btn" onClick={() => setEditingPassword(true)} disabled={busy}>
              {link.passwordProtected ? 'Change' : 'Add password'}
            </button>
            {link.passwordProtected && (
              <button className="link-btn danger" onClick={() => onUpdate({ password: '' })} disabled={busy}>
                Remove
              </button>
            )}
          </div>
        ) : (
          <form className="share-password-row" onSubmit={savePassword}>
            <input
              className="text-input"
              type="password"
              placeholder="New password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button className="btn btn-primary" type="submit" disabled={busy || !password}>
              Save
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => {
                setEditingPassword(false);
                setPassword('');
              }}
            >
              Cancel
            </button>
          </form>
        )}
      </div>

      {isFolder && (
        <label className="checkbox-row share-setting">
          <input
            type="checkbox"
            checked={uploadEnabled}
            onChange={async (e) => {
              const next = e.target.checked;
              setUploadEnabled(next);
              if (!(await onUpdate({ uploadEnabled: next }))) setUploadEnabled(!next);
            }}
          />
          Visitors can upload files into this folder
        </label>
      )}

      <button className="link-btn danger" onClick={onTurnOff} disabled={busy}>
        Turn off link
      </button>
    </>
  );
}

function LinkSection({ title, description, link, isFolder, onCreate, onUpdate, onTurnOff, createLabel }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async (fn) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="share-section">
      <div className="share-section-header">
        <h4>{title}</h4>
        <label className="switch" title={link ? 'Turn off link' : 'Turn on link'}>
          <input
            type="checkbox"
            checked={Boolean(link)}
            disabled={busy}
            onChange={(e) => run(e.target.checked ? onCreate : onTurnOff)}
            aria-label="Link sharing"
          />
          <span className="switch-track" />
        </label>
      </div>
      {!link && (
        <>
          <p className="muted small">{description}</p>
          <button className="btn" onClick={() => run(onCreate)} disabled={busy}>
            {createLabel}
          </button>
        </>
      )}
      {link && (
        <>
          <p className="muted small">Anyone who has this link can open it - no account needed.</p>
          <LinkSettings
            link={link}
            isFolder={isFolder}
            busy={busy}
            onUpdate={(body) => run(() => onUpdate(body))}
            onTurnOff={() => run(onTurnOff)}
          />
        </>
      )}
      {error && <p className="form-error">{error}</p>}
    </section>
  );
}

// --- Dialog -----------------------------------------------------------------

function nodeLink(node) {
  if (!node.shareToken) return null;
  return {
    token: node.shareToken,
    expiresAt: node.shareExpiresAt,
    expired: node.shareExpired,
    passwordProtected: node.sharePasswordProtected,
    uploadEnabled: node.shareUploadEnabled,
  };
}

function SingleShare({ initialNode, onChanged }) {
  const [node, setNode] = useState(initialNode);
  const apply = useCallback(
    async (fn) => {
      const data = await fn();
      if (data?.item) setNode(data.item);
      onChanged?.();
    },
    [onChanged]
  );
  const isFolder = node.type === 'folder';
  return (
    <>
      <PeopleSection node={node} onChanged={onChanged} />
      <hr className="divider" />
      <LinkSection
        title="Link sharing"
        description="Off - only you and the people above can open this."
        createLabel="Create link"
        link={nodeLink(node)}
        isFolder={isFolder}
        onCreate={() => apply(() => api.share(node.id, {}))}
        onUpdate={(body) => apply(() => api.share(node.id, body))}
        onTurnOff={() => apply(() => api.unshare(node.id))}
      />
    </>
  );
}

function MultiShare({ items, initialBundle, onChanged }) {
  const [bundle, setBundle] = useState(initialBundle || null);
  const names = items.map((i) => i.name);
  const link = bundle
    ? { token: bundle.token, expiresAt: bundle.expiresAt, expired: bundle.expired, passwordProtected: bundle.passwordProtected }
    : null;
  return (
    <>
      <p className="muted small share-includes">
        {names.slice(0, 4).join(', ')}
        {names.length > 4 ? ` and ${names.length - 4} more` : ''}
      </p>
      <BulkPeopleSection items={items} onChanged={onChanged} />
      <hr className="divider" />
      <LinkSection
        title="One link for all of these"
        description="Visitors get a single page listing just these items."
        createLabel={`Create link for ${items.length} items`}
        link={link}
        isFolder={false}
        onCreate={async () => {
          const { bundle: b } = await api.shareBundle(items.map((i) => i.id));
          setBundle(b);
          onChanged?.();
        }}
        onUpdate={async (body) => {
          const { bundle: b } = await api.patchShareBundle(bundle.id, body);
          setBundle(b);
          onChanged?.();
        }}
        onTurnOff={async () => {
          await api.deleteShareBundle(bundle.id);
          setBundle(null);
          onChanged?.();
        }}
      />
    </>
  );
}

// One place for every way of sharing: specific people (by account) and a
// public link. `items` is one node or a multi-selection; `bundle`, when
// given, is an existing multi-item link being managed (from "Shared by me").
export default function ShareDialog({ items, bundle, onChanged, onClose }) {
  const single = items.length === 1 && !bundle;
  const title = single ? `Share “${items[0].name}”` : `Share ${items.length} items`;
  return (
    <Modal
      title={title}
      onClose={onClose}
      width={520}
      footer={
        <button className="btn btn-primary" onClick={onClose}>
          Done
        </button>
      }
    >
      {single ? (
        <SingleShare initialNode={items[0]} onChanged={onChanged} />
      ) : (
        <MultiShare items={items} initialBundle={bundle} onChanged={onChanged} />
      )}
    </Modal>
  );
}
