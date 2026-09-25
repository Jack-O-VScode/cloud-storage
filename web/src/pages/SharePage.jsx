import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, shareUploadFiles } from '../api.js';
import Icon from '../components/Icon.jsx';
import { formatBytes, mimeCategory } from '../utils/format.js';

function FilePreview({ token, item }) {
  const category = mimeCategory(item);
  const url = api.shareDownloadUrl(token, item.id);
  if (category === 'image') return <img className="preview-media" src={url} alt={item.name} />;
  if (category === 'video')
    return (
      <video className="preview-media" src={url} controls>
        Your browser can't play this video.
      </video>
    );
  if (category === 'audio') return <audio className="preview-audio" src={url} controls />;
  return null;
}

const BUNDLE_ROOT_CRUMB = { id: '__root__', name: 'Shared files' };

export default function SharePage({ token }) {
  const [meta, setMeta] = useState(null); // { item, passwordRequired } | { bundle, items, passwordRequired }
  const [unlocked, setUnlocked] = useState(false);
  const [password, setPassword] = useState('');
  const [unlockError, setUnlockError] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [loadError, setLoadError] = useState('');

  const [currentNode, setCurrentNode] = useState(null); // current folder being browsed
  const [items, setItems] = useState([]);
  const [breadcrumb, setBreadcrumb] = useState([]);
  const [browsing, setBrowsing] = useState(false);

  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const fileInputRef = useRef(null);

  const isBundle = Boolean(meta?.bundle);

  const loadMeta = useCallback(() => {
    api
      .shareMeta(token)
      .then((data) => {
        setMeta(data);
        setUnlocked(!data.passwordRequired);
      })
      .catch((e) => setLoadError(e.message));
  }, [token]);

  useEffect(() => {
    loadMeta();
  }, [loadMeta]);

  const loadFolder = useCallback(
    (nodeId) => {
      setBrowsing(true);
      api
        .shareList(token, nodeId)
        .then((data) => {
          setItems(data.items);
          setBreadcrumb(data.breadcrumb);
          setCurrentNode(data.breadcrumb[data.breadcrumb.length - 1] || meta.item);
        })
        .catch((e) => setLoadError(e.message))
        .finally(() => setBrowsing(false));
    },
    [token, meta]
  );

  const loadBundleRoot = useCallback(() => {
    setBrowsing(true);
    api
      .shareList(token)
      .then((data) => {
        setItems(data.items);
        setBreadcrumb([]);
        setCurrentNode(null);
      })
      .catch((e) => setLoadError(e.message))
      .finally(() => setBrowsing(false));
  }, [token]);

  useEffect(() => {
    if (!unlocked) return;
    if (meta?.bundle) {
      loadBundleRoot();
    } else if (meta?.item?.type === 'folder') {
      loadFolder(meta.item.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlocked, meta?.item?.id, meta?.bundle]);

  const unlock = async (e) => {
    e.preventDefault();
    setUnlocking(true);
    setUnlockError('');
    try {
      await api.shareUnlock(token, password);
      setUnlocked(true);
      loadMeta();
    } catch (err) {
      setUnlockError(err.message);
    } finally {
      setUnlocking(false);
    }
  };

  const handleUpload = async (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setUploading(true);
    setUploadError('');
    try {
      await shareUploadFiles(token, files, currentNode?.id);
      if (currentNode) loadFolder(currentNode.id);
      else loadFolder(meta.item.id);
    } catch (err) {
      setUploadError(err.message);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  if (loadError) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <h1>Not available</h1>
          <p className="form-error">{loadError}</p>
        </div>
      </div>
    );
  }

  if (!meta) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <p className="muted">Loading…</p>
        </div>
      </div>
    );
  }

  if (!unlocked) {
    return (
      <div className="auth-screen">
        <form className="auth-card" onSubmit={unlock}>
          <h1>Password required</h1>
          <p className="muted">
            {isBundle ? 'This shared selection is password protected.' : `"${meta.item.name}" is password protected.`}
          </p>
          <label className="field-label">Password</label>
          <input
            className="text-input"
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {unlockError && <p className="form-error">{unlockError}</p>}
          <button className="btn btn-primary btn-block" disabled={unlocking}>
            Unlock
          </button>
        </form>
      </div>
    );
  }

  if (!isBundle && meta.item.type === 'file') {
    return (
      <div className="auth-screen">
        <div className="auth-card share-file-card">
          <h1>{meta.item.name}</h1>
          <p className="muted">{formatBytes(meta.item.size)}</p>
          <FilePreview token={token} item={meta.item} />
          <a className="btn btn-primary btn-block" href={api.shareDownloadUrl(token, meta.item.id)}>
            Download
          </a>
        </div>
      </div>
    );
  }

  // Folder or bundle: browsable view.
  const crumbs = isBundle ? [BUNDLE_ROOT_CRUMB, ...breadcrumb] : breadcrumb;

  return (
    <div className="share-browse-screen">
      <div className="share-browse-header">
        <div className="breadcrumb">
          {crumbs.map((b, i) => (
            <React.Fragment key={b.id}>
              {i > 0 && <span> / </span>}
              <button className="link-btn" onClick={() => (b.id === '__root__' ? loadBundleRoot() : loadFolder(b.id))}>
                {b.name}
              </button>
            </React.Fragment>
          ))}
        </div>
        <div className="share-browse-actions">
          {meta.uploadEnabled && !isBundle && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => handleUpload(e.target.files)}
              />
              <button className="btn" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
                {uploading ? 'Uploading…' : 'Upload files'}
              </button>
            </>
          )}
          <a className="btn btn-primary" href={api.shareZipUrl(token, currentNode?.id)}>
            Download all as zip
          </a>
        </div>
      </div>
      {uploadError && <p className="form-error" style={{ margin: '0 24px' }}>{uploadError}</p>}
      <div className="items-table">
        <div className="items-header two-col">
          <span>Name</span>
          <span>Size</span>
        </div>
        {browsing && <p className="muted" style={{ padding: '12px 16px' }}>Loading…</p>}
        {!browsing && items.length === 0 && <div className="empty-state">This folder is empty.</div>}
        {!browsing &&
          items.map((item) => (
            <div
              key={item.id}
              className="items-row two-col"
              onDoubleClick={() => (item.type === 'folder' ? loadFolder(item.id) : null)}
            >
              <span className="items-name">
                <Icon category={mimeCategory(item)} />
                <span className="items-name-text">{item.name}</span>
              </span>
              <span className="muted">
                {item.type === 'file' ? (
                  <a href={api.shareDownloadUrl(token, item.id)}>{formatBytes(item.size)} · Download</a>
                ) : (
                  '—'
                )}
              </span>
            </div>
          ))}
      </div>
    </div>
  );
}
