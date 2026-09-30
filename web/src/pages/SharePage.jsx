import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import Icon from '../components/Icon.jsx';
import Modal from '../components/Modal.jsx';
import { enqueue, onUploadComplete } from '../uploads/uploadManager.js';
import { formatBytes, mimeCategory } from '../utils/format.js';
import { filesToEntries, collectFilesFromDataTransfer } from '../utils/collectFiles.js';

const PREVIEWABLE = new Set(['image', 'video', 'audio', 'pdf']);

function FilePreview({ token, item }) {
  const category = mimeCategory(item);
  const url = api.shareDownloadUrl(token, item.id);
  if (category === 'image') return <img className="preview-media" src={url} alt={item.name} />;
  if (category === 'video')
    return (
      <video className="preview-media" src={url} controls playsInline>
        Your browser can't play this video.
      </video>
    );
  if (category === 'audio') return <audio className="preview-audio" src={url} controls />;
  if (category === 'pdf') return <iframe className="preview-frame" src={url} title={item.name} />;
  return null;
}

function RowIcon({ token, item }) {
  const category = mimeCategory(item);
  if (category === 'image' && item.hasThumbnail) {
    return <img className="items-thumb" src={api.shareThumbnailUrl(token, item.id)} loading="lazy" alt="" />;
  }
  return <Icon category={category} />;
}

// A visitor's view of a shared link. Deliberately simple: browse, preview,
// download - and, when the owner allowed it, upload into the folder.
export default function SharePage({ token }) {
  const [meta, setMeta] = useState(null); // { item, passwordRequired, uploadEnabled } | { bundle, items, passwordRequired }
  const [unlocked, setUnlocked] = useState(false);
  const [password, setPassword] = useState('');
  const [unlockError, setUnlockError] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [loadError, setLoadError] = useState('');

  const [currentId, setCurrentId] = useState(null); // folder being browsed (null = link root)
  const [items, setItems] = useState([]);
  const [breadcrumb, setBreadcrumb] = useState([]);
  const [browsing, setBrowsing] = useState(false);
  const [preview, setPreview] = useState(null);
  const [dragActive, setDragActive] = useState(false);
  const dragCounter = useRef(0);
  const fileInputRef = useRef(null);

  const isBundle = Boolean(meta?.bundle);
  const canUpload = Boolean(meta?.uploadEnabled) && !isBundle;
  const touch = typeof window !== 'undefined' && window.matchMedia?.('(hover: none)').matches;

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

  const load = useCallback(
    (nodeId) => {
      setBrowsing(true);
      api
        .shareList(token, nodeId || undefined)
        .then((data) => {
          setItems(data.items);
          setBreadcrumb(data.breadcrumb);
          setCurrentId(nodeId || null);
        })
        .catch((e) => setLoadError(e.message))
        .finally(() => setBrowsing(false));
    },
    [token]
  );

  useEffect(() => {
    if (!unlocked || !meta) return;
    if (meta.bundle) load(null);
    else if (meta.item?.type === 'folder') load(meta.item.id);
  }, [unlocked, meta, load]);

  // Files a visitor uploads show up as each one finishes.
  const currentIdRef = useRef(currentId);
  currentIdRef.current = currentId;
  useEffect(() => {
    let timer = null;
    const off = onUploadComplete(() => {
      clearTimeout(timer);
      timer = setTimeout(() => load(currentIdRef.current || meta?.item?.id), 500);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [load, meta]);

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

  const startUpload = (entries) => {
    // A shared folder takes loose files - folders are flattened into it.
    const files = entries.map((e) => e.file);
    if (!files.length) return;
    const folderId = currentId || meta.item.id;
    const folderName = breadcrumb[breadcrumb.length - 1]?.name || meta.item.name;
    enqueue(
      files.map((file) => ({ file, targetLabel: folderName, initBody: { nodeId: folderId } })),
      { base: api.shareUploadBase(token) }
    );
  };

  const openItem = (item) => {
    if (item.type === 'folder') load(item.id);
    else setPreview(item);
  };

  if (loadError) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <h1>Not available</h1>
          <p className="form-error">{loadError}</p>
          <p className="muted small">The link may have been turned off, or it has expired.</p>
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
            {isBundle ? 'These shared files are password protected.' : `“${meta.item.name}” is password protected.`}
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
          <a className="btn btn-primary btn-block" href={`${api.shareDownloadUrl(token, meta.item.id)}&download=1`}>
            Download
          </a>
        </div>
      </div>
    );
  }

  // Folder or multi-item link: a browsable list.
  const rootLabel = isBundle ? 'Shared files' : meta.item.name;
  const rootId = isBundle ? null : meta.item.id;
  const trail = isBundle ? breadcrumb : breadcrumb.slice(1);

  const dragHandlers = canUpload
    ? {
        onDragEnter: (e) => {
          e.preventDefault();
          dragCounter.current += 1;
          setDragActive(true);
        },
        onDragLeave: (e) => {
          e.preventDefault();
          dragCounter.current -= 1;
          if (dragCounter.current <= 0) setDragActive(false);
        },
        onDragOver: (e) => e.preventDefault(),
        onDrop: async (e) => {
          e.preventDefault();
          dragCounter.current = 0;
          setDragActive(false);
          startUpload(await collectFilesFromDataTransfer(e.dataTransfer));
        },
      }
    : {};

  return (
    <div className="share-browse-screen" {...dragHandlers}>
      <div className="share-browse-header">
        <div className="breadcrumb">
          <button className="link-btn" onClick={() => load(rootId)}>
            {rootLabel}
          </button>
          {trail.map((b) => (
            <React.Fragment key={b.id}>
              <span> / </span>
              <button className="link-btn" onClick={() => load(b.id)}>
                {b.name}
              </button>
            </React.Fragment>
          ))}
        </div>
        <div className="share-browse-actions">
          {canUpload && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => {
                  startUpload(filesToEntries(e.target.files));
                  e.target.value = '';
                }}
              />
              <button className="btn" onClick={() => fileInputRef.current?.click()}>
                Upload files
              </button>
            </>
          )}
          <a className="btn btn-primary" href={api.shareZipUrl(token, currentId || undefined)}>
            Download all
          </a>
        </div>
      </div>
      {canUpload && <p className="muted small share-upload-hint">You can add files to this folder - drop them here or use Upload.</p>}
      {dragActive && <div className="drop-overlay">Drop files to add them to this folder</div>}
      <div className="items-table">
        <div className="items-header two-col">
          <span>Name</span>
          <span>Size</span>
        </div>
        {browsing && items.length === 0 && <p className="muted" style={{ padding: '12px 16px' }}>Loading…</p>}
        {!browsing && items.length === 0 && <div className="empty-state">This folder is empty.</div>}
        {items.map((item) => {
          const previewable = item.type === 'folder' || PREVIEWABLE.has(mimeCategory(item));
          return (
            <div
              key={item.id}
              className="items-row two-col clickable"
              onClick={(e) => {
                if (e.target.closest('a')) return;
                if (touch || e.target.closest('.items-name-text')) {
                  if (item.type === 'folder' || previewable) openItem(item);
                }
              }}
              onDoubleClick={() => !touch && previewable && openItem(item)}
            >
              <span className="items-name">
                <RowIcon token={token} item={item} />
                <span className={`items-name-text ${previewable ? 'openable' : ''}`}>{item.name}</span>
              </span>
              <span className="muted share-row-size">
                {item.type === 'file' ? (
                  <a href={`${api.shareDownloadUrl(token, item.id)}&download=1`}>{formatBytes(item.size)} · Download</a>
                ) : (
                  'Folder'
                )}
              </span>
            </div>
          );
        })}
      </div>

      {preview && (
        <Modal
          title={preview.name}
          onClose={() => setPreview(null)}
          width={mimeCategory(preview) === 'image' || mimeCategory(preview) === 'video' ? 720 : 560}
          footer={
            <>
              <a className="btn" href={`${api.shareDownloadUrl(token, preview.id)}&download=1`}>
                Download
              </a>
              <button className="btn btn-primary" onClick={() => setPreview(null)}>
                Close
              </button>
            </>
          }
        >
          <FilePreview token={token} item={preview} />
        </Modal>
      )}
    </div>
  );
}
