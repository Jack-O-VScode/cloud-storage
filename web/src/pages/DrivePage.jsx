import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, uploadFiles, downloadZip } from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../components/Toasts.jsx';
import ItemsList from '../components/ItemsList.jsx';
import TextPromptModal from '../components/TextPromptModal.jsx';
import MoveModal from '../components/MoveModal.jsx';
import ShareModal from '../components/ShareModal.jsx';
import PreviewModal from '../components/PreviewModal.jsx';
import UsersAdminModal from '../components/UsersAdminModal.jsx';
import { ConfirmDialog } from '../components/Modal.jsx';
import { formatBytes } from '../utils/format.js';
import { filesToEntries, collectFilesFromDataTransfer } from '../utils/collectFiles.js';

export default function DrivePage() {
  const { user, logout } = useAuth();
  const toast = useToast();

  const [view, setView] = useState('browse'); // browse | trash | search
  const [parentId, setParentId] = useState('root');
  const [breadcrumb, setBreadcrumb] = useState([]);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [usage, setUsage] = useState(null);
  const [dragActive, setDragActive] = useState(false);
  const [uploadPct, setUploadPct] = useState(null);

  const [modal, setModal] = useState(null); // { type, node? }
  const [selectedIds, setSelectedIds] = useState(new Set());
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const dragCounter = useRef(0);

  useEffect(() => {
    setSelectedIds(new Set());
  }, [view, parentId, searchQuery]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      if (view === 'trash') {
        const data = await api.listTrash();
        setItems(data.items);
        setBreadcrumb([]);
      } else if (view === 'search') {
        const data = await api.search(searchQuery);
        setItems(data.items);
        setBreadcrumb([]);
      } else {
        const data = await api.listNodes(parentId);
        setItems(data.items);
        setBreadcrumb(data.breadcrumb);
      }
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [view, parentId, searchQuery]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const refreshUsage = useCallback(() => {
    api.usage().then(setUsage).catch(() => {});
  }, []);

  useEffect(() => {
    refreshUsage();
  }, [refreshUsage]);

  const goRoot = () => {
    setView('browse');
    setParentId('root');
  };

  const openFolder = (id) => {
    setView('browse');
    setParentId(id);
  };

  const openItem = (node) => {
    if (node.type === 'folder') {
      openFolder(node.id);
    } else {
      setModal({ type: 'preview', node });
    }
  };

  // `entries` is [{file, relativePath}] - relativePath is empty for a flat
  // file upload, or e.g. "Photos/2024/img.jpg" when uploading a folder, so
  // the server can recreate the folder structure instead of flattening it.
  const doUploadEntries = async (entries) => {
    if (entries.length === 0) return;
    setUploadPct(0);
    try {
      const files = entries.map((e) => e.file);
      const relativePaths = entries.map((e) => e.relativePath || '');
      const hasPaths = relativePaths.some(Boolean);
      await uploadFiles(files, parentId, (p) => setUploadPct(p), hasPaths ? relativePaths : undefined);
      toast.push(`Uploaded ${files.length} item${files.length > 1 ? 's' : ''}`, 'success');
      refresh();
      refreshUsage();
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setUploadPct(null);
    }
  };

  // Drag-and-drop upload (files or whole folders) anywhere over the content area.
  const onDragEnter = (e) => {
    e.preventDefault();
    if (view !== 'browse') return;
    dragCounter.current += 1;
    setDragActive(true);
  };
  const onDragLeave = (e) => {
    e.preventDefault();
    dragCounter.current -= 1;
    if (dragCounter.current <= 0) setDragActive(false);
  };
  const onDragOver = (e) => e.preventDefault();
  const onDrop = async (e) => {
    e.preventDefault();
    dragCounter.current = 0;
    setDragActive(false);
    if (view !== 'browse') return;
    const entries = await collectFilesFromDataTransfer(e.dataTransfer);
    if (entries.length) doUploadEntries(entries);
  };

  const actions = {
    download: async (node) => {
      if (node.type === 'folder') {
        try {
          await downloadZip([node.id]);
        } catch (err) {
          toast.push(err.message, 'error');
        }
      } else {
        const a = document.createElement('a');
        a.href = api.downloadUrl(node.id);
        a.click();
      }
    },
    share: (node) => setModal({ type: 'share', node }),
    rename: (node) => setModal({ type: 'rename', node }),
    move: (node) => setModal({ type: 'move', node }),
    trash: async (node) => {
      await api.patchNode(node.id, { trashed: true });
      toast.push(`Moved "${node.name}" to trash`, 'success');
      refresh();
      refreshUsage();
    },
    restore: async (node) => {
      await api.patchNode(node.id, { trashed: false });
      toast.push(`Restored "${node.name}"`, 'success');
      refresh();
      refreshUsage();
    },
    deleteForever: (node) => setModal({ type: 'delete-forever', node }),
  };

  const toggleSelect = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleSelectAll = () => {
    setSelectedIds((prev) => (prev.size === items.length ? new Set() : new Set(items.map((i) => i.id))));
  };
  const clearSelection = () => setSelectedIds(new Set());
  const selectedNodes = items.filter((i) => selectedIds.has(i.id));

  const bulkDownload = async () => {
    try {
      await downloadZip([...selectedIds]);
    } catch (err) {
      toast.push(err.message, 'error');
    }
  };
  const bulkTrash = async () => {
    await Promise.all(selectedNodes.map((n) => api.patchNode(n.id, { trashed: true })));
    toast.push(`Moved ${selectedNodes.length} item(s) to trash`, 'success');
    clearSelection();
    refresh();
    refreshUsage();
  };
  const bulkRestore = async () => {
    await Promise.all(selectedNodes.map((n) => api.patchNode(n.id, { trashed: false })));
    toast.push(`Restored ${selectedNodes.length} item(s)`, 'success');
    clearSelection();
    refresh();
    refreshUsage();
  };

  const closeModal = () => setModal(null);

  const isAdmin = user?.isAdmin;

  return (
    <div
      className="app-shell"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <aside className="sidebar">
        <div className="brand">☁️ Cloud Storage</div>
        <button className="btn btn-primary btn-block new-btn" onClick={() => setModal({ type: 'new-folder' })}>
          + New folder
        </button>
        <button className="btn btn-block" onClick={() => fileInputRef.current?.click()}>
          Upload files
        </button>
        <button className="btn btn-block" onClick={() => folderInputRef.current?.click()}>
          Upload folder
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            doUploadEntries(filesToEntries(e.target.files));
            e.target.value = '';
          }}
        />
        <input
          ref={(el) => {
            folderInputRef.current = el;
            // webkitdirectory/directory aren't recognized JSX props, so set
            // them imperatively - this is what puts the browser's file
            // picker into folder-selection mode.
            if (el) {
              el.setAttribute('webkitdirectory', '');
              el.setAttribute('directory', '');
            }
          }}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            doUploadEntries(filesToEntries(e.target.files));
            e.target.value = '';
          }}
        />
        <nav className="side-nav">
          <button className={`side-nav-item ${view === 'browse' ? 'active' : ''}`} onClick={goRoot}>
            My Drive
          </button>
          <button
            className={`side-nav-item ${view === 'trash' ? 'active' : ''}`}
            onClick={() => setView('trash')}
          >
            Trash
          </button>
        </nav>
        <div className="sidebar-spacer" />
        {usage && (
          <div className="usage-box">
            <div className="usage-bar">
              <div
                className="usage-bar-fill"
                style={{
                  width: usage.quotaBytes
                    ? `${Math.min(100, (usage.bytesUsed / usage.quotaBytes) * 100)}%`
                    : usage.disk?.total
                    ? `${Math.min(100, (usage.disk.used / usage.disk.total) * 100)}%`
                    : '0%',
                }}
              />
            </div>
            <div className="muted small">
              {usage.quotaBytes ? (
                <>
                  {formatBytes(usage.bytesUsed)} of {formatBytes(usage.quotaBytes)} used
                </>
              ) : (
                <>
                  {formatBytes(usage.bytesUsed)} used by you
                  {usage.disk?.total && <> · {formatBytes(usage.disk.free)} free on disk</>}
                </>
              )}
            </div>
          </div>
        )}
        {isAdmin && (
          <button className="link-btn" onClick={() => setModal({ type: 'users' })}>
            Manage users
          </button>
        )}
        <div className="user-row">
          <span>{user?.username}</span>
          <button className="link-btn" onClick={logout}>
            Log out
          </button>
        </div>
      </aside>

      <main className="content">
        <div className="top-bar">
          {view === 'browse' && (
            <div className="breadcrumb">
              <button className="link-btn" onClick={goRoot}>
                My Drive
              </button>
              {breadcrumb.map((b) => (
                <React.Fragment key={b.id}>
                  <span> / </span>
                  <button className="link-btn" onClick={() => openFolder(b.id)}>
                    {b.name}
                  </button>
                </React.Fragment>
              ))}
            </div>
          )}
          {view === 'trash' && (
            <div className="breadcrumb">
              <strong>Trash</strong>
              {items.length > 0 && (
                <button className="link-btn danger" onClick={() => setModal({ type: 'empty-trash' })}>
                  Empty trash
                </button>
              )}
            </div>
          )}
          <input
            className="search-input"
            placeholder="Search your files…"
            value={searchQuery}
            onChange={(e) => {
              const q = e.target.value;
              setSearchQuery(q);
              setView(q.trim() ? 'search' : 'browse');
            }}
          />
        </div>

        {uploadPct !== null && (
          <div className="upload-progress">
            <div className="upload-progress-fill" style={{ width: `${uploadPct * 100}%` }} />
          </div>
        )}

        {selectedIds.size > 0 && (
          <div className="selection-bar">
            <span>{selectedIds.size} selected</span>
            {view !== 'trash' ? (
              <>
                <button className="btn" onClick={bulkDownload}>
                  Download
                </button>
                <button className="btn" onClick={() => setModal({ type: 'bulk-move' })}>
                  Move
                </button>
                <button className="btn btn-danger" onClick={bulkTrash}>
                  Move to trash
                </button>
              </>
            ) : (
              <>
                <button className="btn" onClick={bulkRestore}>
                  Restore
                </button>
                <button className="btn btn-danger" onClick={() => setModal({ type: 'bulk-delete-forever' })}>
                  Delete forever
                </button>
              </>
            )}
            <button className="link-btn" onClick={clearSelection}>
              Clear
            </button>
          </div>
        )}

        {dragActive && <div className="drop-overlay">Drop files to upload</div>}

        {loading ? (
          <div className="empty-state">Loading…</div>
        ) : (
          <ItemsList
            items={items}
            trashView={view === 'trash'}
            onOpen={openItem}
            actions={actions}
            selectedIds={selectedIds}
            onToggleSelect={toggleSelect}
            onToggleSelectAll={toggleSelectAll}
          />
        )}
      </main>

      {modal?.type === 'new-folder' && (
        <TextPromptModal
          title="New folder"
          label="Folder name"
          confirmLabel="Create"
          onCancel={closeModal}
          onSubmit={async (name) => {
            await api.createFolder(name, parentId);
            closeModal();
            refresh();
          }}
        />
      )}

      {modal?.type === 'rename' && (
        <TextPromptModal
          title="Rename"
          label="Name"
          initialValue={modal.node.name}
          confirmLabel="Rename"
          onCancel={closeModal}
          onSubmit={async (name) => {
            await api.patchNode(modal.node.id, { name });
            closeModal();
            refresh();
          }}
        />
      )}

      {modal?.type === 'move' && (
        <MoveModal
          title={`Move "${modal.node.name}"`}
          excludeIds={new Set([modal.node.id])}
          onCancel={closeModal}
          onMove={async (targetParentId) => {
            await api.patchNode(modal.node.id, { parentId: targetParentId });
            toast.push(`Moved "${modal.node.name}"`, 'success');
            closeModal();
            refresh();
          }}
        />
      )}

      {modal?.type === 'bulk-move' && (
        <MoveModal
          title={`Move ${selectedIds.size} items`}
          excludeIds={selectedIds}
          onCancel={closeModal}
          onMove={async (targetParentId) => {
            await Promise.all(selectedNodes.map((n) => api.patchNode(n.id, { parentId: targetParentId })));
            toast.push(`Moved ${selectedNodes.length} item(s)`, 'success');
            clearSelection();
            closeModal();
            refresh();
          }}
        />
      )}

      {modal?.type === 'share' && (
        <ShareModal node={modal.node} onChanged={refresh} onClose={() => { closeModal(); refresh(); }} />
      )}

      {modal?.type === 'preview' && <PreviewModal node={modal.node} onClose={closeModal} />}

      {modal?.type === 'delete-forever' && (
        <ConfirmDialog
          title="Delete forever"
          message={`Permanently delete "${modal.node.name}"? This can't be undone.`}
          confirmLabel="Delete forever"
          danger
          onCancel={closeModal}
          onConfirm={async () => {
            await api.deleteNode(modal.node.id);
            closeModal();
            refresh();
            refreshUsage();
          }}
        />
      )}

      {modal?.type === 'bulk-delete-forever' && (
        <ConfirmDialog
          title="Delete forever"
          message={`Permanently delete ${selectedNodes.length} item(s)? This can't be undone.`}
          confirmLabel="Delete forever"
          danger
          onCancel={closeModal}
          onConfirm={async () => {
            await Promise.all(selectedNodes.map((n) => api.deleteNode(n.id)));
            clearSelection();
            closeModal();
            refresh();
            refreshUsage();
          }}
        />
      )}

      {modal?.type === 'empty-trash' && (
        <ConfirmDialog
          title="Empty trash"
          message="Permanently delete everything in the trash? This can't be undone."
          confirmLabel="Empty trash"
          danger
          onCancel={closeModal}
          onConfirm={async () => {
            await api.emptyTrash();
            closeModal();
            refresh();
            refreshUsage();
          }}
        />
      )}

      {modal?.type === 'users' && <UsersAdminModal onClose={closeModal} />}
    </div>
  );
}
