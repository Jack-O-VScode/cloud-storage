import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, uploadFiles, uploadVersion, downloadZip } from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../components/Toasts.jsx';
import ItemsList from '../components/ItemsList.jsx';
import Icon from '../components/Icon.jsx';
import TextPromptModal from '../components/TextPromptModal.jsx';
import MoveModal from '../components/MoveModal.jsx';
import ShareModal from '../components/ShareModal.jsx';
import BundleShareModal from '../components/BundleShareModal.jsx';
import PreviewModal from '../components/PreviewModal.jsx';
import UsersAdminModal from '../components/UsersAdminModal.jsx';
import BackupsModal from '../components/BackupsModal.jsx';
import ActivityModal from '../components/ActivityModal.jsx';
import SettingsModal from '../components/SettingsModal.jsx';
import StorageModal from '../components/StorageModal.jsx';
import CommandPalette from '../components/CommandPalette.jsx';
import VersionHistoryModal from '../components/VersionHistoryModal.jsx';
import CommentsModal from '../components/CommentsModal.jsx';
import AccessModal from '../components/AccessModal.jsx';
import { ConfirmDialog } from '../components/Modal.jsx';
import { formatBytes, formatSpeed, formatDuration } from '../utils/format.js';
import { filesToEntries, collectFilesFromDataTransfer } from '../utils/collectFiles.js';

const PAGE_SIZE = 200;

export default function DrivePage() {
  const { user, logout } = useAuth();
  const toast = useToast();

  const [view, setView] = useState('browse'); // browse | trash | search | starred | recent | shared-with-me
  const [parentId, setParentId] = useState('root');
  const [breadcrumb, setBreadcrumb] = useState([]);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  // Set while browsing inside a folder someone else granted us access to -
  // `sharedPermission` is the level of that grant (view/upload/edit), and
  // gates which actions the UI offers for the whole session.
  const [sharedMode, setSharedMode] = useState(false);
  const [sharedPermission, setSharedPermission] = useState(null);
  const [sharedFolders, setSharedFolders] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [usage, setUsage] = useState(null);
  const [dragActive, setDragActive] = useState(false);
  const [uploadPct, setUploadPct] = useState(null);
  const [uploadStats, setUploadStats] = useState(null); // { loadedBytes, totalBytes, bytesPerSecond }
  const [downloadStats, setDownloadStats] = useState(null); // { loadedBytes, bytesPerSecond } | null

  const [modal, setModal] = useState(null); // { type, node? }
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [sortBy, setSortBy] = useState('name');
  const [sortDir, setSortDir] = useState('asc');
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [internalDragActive, setInternalDragActive] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const versionInputRef = useRef(null);
  const versionTargetNode = useRef(null);
  const dragCounter = useRef(0);

  // Detects a drag that originated from one of our own rows (as opposed to
  // an OS file drag) so the "drop files to upload" overlay doesn't flash
  // while the user is just reordering items into a folder.
  useEffect(() => {
    const onStart = () => setInternalDragActive(true);
    const onEnd = () => setInternalDragActive(false);
    window.addEventListener('dragstart', onStart);
    window.addEventListener('dragend', onEnd);
    return () => {
      window.removeEventListener('dragstart', onStart);
      window.removeEventListener('dragend', onEnd);
    };
  }, []);

  useEffect(() => {
    setSelectedIds(new Set());
  }, [view, parentId, searchQuery]);

  // Ctrl/Cmd+K opens the command palette from anywhere in the app.
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

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
      } else if (view === 'starred') {
        const data = await api.listStarred();
        setItems(data.items);
        setBreadcrumb([]);
      } else if (view === 'recent') {
        const data = await api.listRecent();
        setItems(data.items);
        setBreadcrumb([]);
      } else if (view === 'shared-with-me') {
        const data = await api.listSharedWithMe();
        setSharedFolders(data.items);
        setItems([]);
        setBreadcrumb([]);
      } else {
        // Sorting happens server-side (so "Load more" keeps paging through
        // one consistent order) - a fresh browse fetch always starts back
        // at the top of the folder.
        const data = await api.listNodes(parentId, { sortBy, sortDir, offset: 0, limit: PAGE_SIZE });
        setItems(data.items);
        setBreadcrumb(data.breadcrumb);
        setHasMore(data.hasMore);
      }
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [view, parentId, searchQuery, sortBy, sortDir]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const loadMore = async () => {
    if (view !== 'browse' || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await api.listNodes(parentId, { sortBy, sortDir, offset: items.length, limit: PAGE_SIZE });
      setItems((prev) => [...prev, ...data.items]);
      setHasMore(data.hasMore);
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setLoadingMore(false);
    }
  };

  const refreshUsage = useCallback(() => {
    api.usage().then(setUsage).catch(() => {});
  }, []);

  useEffect(() => {
    refreshUsage();
  }, [refreshUsage]);

  const goRoot = () => {
    setView('browse');
    setParentId('root');
    setSharedMode(false);
    setSharedPermission(null);
  };

  const openFolder = (id) => {
    setView('browse');
    setParentId(id);
  };

  const openSharedFolder = (entry) => {
    setSharedMode(true);
    setSharedPermission(entry.permission);
    setView('browse');
    setParentId(entry.id);
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
      await uploadFiles(
        files,
        parentId,
        (info) => {
          setUploadPct(info.fraction);
          setUploadStats(info);
        },
        hasPaths ? relativePaths : undefined
      );
      toast.push(`Uploaded ${files.length} item${files.length > 1 ? 's' : ''}`, 'success');
      refresh();
      refreshUsage();
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setUploadPct(null);
      setUploadStats(null);
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

  const onSortChange = (field) => {
    if (sortBy === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(field);
      setSortDir('asc');
    }
  };

  // The browse view arrives pre-sorted (and paginated) by the server, so
  // re-sorting it client-side would only reorder whatever page happened to
  // be loaded so far. Every other view fetches its whole result set in one
  // go, so sorting it here is still correct.
  const sortedItems =
    view === 'browse'
      ? items
      : [...items].sort((a, b) => {
          if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
          let cmp;
          if (sortBy === 'size') cmp = (a.size || 0) - (b.size || 0);
          else if (sortBy === 'updatedAt') cmp = (a.updatedAt || 0) - (b.updatedAt || 0);
          else cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
          return sortDir === 'asc' ? cmp : -cmp;
        });

  const onMoveItem = async (draggedId, targetFolderId) => {
    const dragged = items.find((i) => i.id === draggedId);
    const previousParentId = dragged?.parentId;
    try {
      await api.patchNode(draggedId, { parentId: targetFolderId });
      toast.push(`Moved "${dragged?.name || 'item'}"`, 'success', 6000, {
        label: 'Undo',
        onClick: async () => {
          await api.patchNode(draggedId, { parentId: previousParentId });
          refresh();
        },
      });
      refresh();
    } catch (err) {
      toast.push(err.message, 'error');
    }
  };

  const shareLinkFor = async (node) => {
    if (node.shareToken) return `${window.location.origin}/s/${node.shareToken}`;
    const { shareToken } = await api.share(node.id, {});
    refresh();
    return `${window.location.origin}/s/${shareToken}`;
  };

  const actions = {
    download: async (node) => {
      if (node.type === 'folder') {
        setDownloadStats({ loadedBytes: 0, bytesPerSecond: 0 });
        try {
          await downloadZip([node.id], setDownloadStats);
        } catch (err) {
          toast.push(err.message, 'error');
        } finally {
          setDownloadStats(null);
        }
      } else {
        const a = document.createElement('a');
        a.href = api.downloadUrl(node.id);
        a.click();
      }
    },
    copyShareLink: async (node) => {
      try {
        const link = await shareLinkFor(node);
        await navigator.clipboard.writeText(link);
        toast.push('Share link copied', 'success');
      } catch (err) {
        toast.push(err.message, 'error');
      }
    },
    nativeShare: async (node) => {
      try {
        const link = await shareLinkFor(node);
        await navigator.share({ title: node.name, url: link });
      } catch (err) {
        // AbortError just means the user closed the share sheet - not an error worth surfacing.
        if (err.name !== 'AbortError') toast.push(err.message, 'error');
      }
    },
    share: (node) => setModal({ type: 'share', node }),
    rename: (node) => setModal({ type: 'rename', node }),
    move: (node) => setModal({ type: 'move', node }),
    trash: async (node) => {
      await api.patchNode(node.id, { trashed: true });
      toast.push(`Moved "${node.name}" to trash`, 'success', 6000, {
        label: 'Undo',
        onClick: async () => {
          await api.patchNode(node.id, { trashed: false });
          refresh();
          refreshUsage();
        },
      });
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
    toggleStar: async (node) => {
      await api.patchNode(node.id, { starred: !node.starred });
      refresh();
    },
    uploadVersion: (node) => {
      versionTargetNode.current = node;
      versionInputRef.current?.click();
    },
    versionHistory: (node) => setModal({ type: 'version-history', node }),
    comments: (node) => setModal({ type: 'comments', node }),
    manageAccess: (node) => setModal({ type: 'access', node }),
  };

  // sharedMode only ever applies while actively browsing inside a shared
  // folder (view === 'browse') - every other view (Trash, Starred, Recent,
  // Search) is always scoped to the current user's own items regardless of
  // whatever shared folder they last had open, so it always reads as owner.
  const viewerRole = view === 'browse' && sharedMode ? sharedPermission : 'owner';
  const canEditHere = viewerRole === 'owner' || viewerRole === 'edit';

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
    setDownloadStats({ loadedBytes: 0, bytesPerSecond: 0 });
    try {
      await downloadZip([...selectedIds], setDownloadStats);
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setDownloadStats(null);
    }
  };
  const bulkTrash = async () => {
    const targets = selectedNodes;
    await Promise.all(targets.map((n) => api.patchNode(n.id, { trashed: true })));
    toast.push(`Moved ${targets.length} item(s) to trash`, 'success', 6000, {
      label: 'Undo',
      onClick: async () => {
        await Promise.all(targets.map((n) => api.patchNode(n.id, { trashed: false })));
        refresh();
        refreshUsage();
      },
    });
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

  const paletteCommands = [
    { id: 'new-folder', label: 'New folder', run: () => setModal({ type: 'new-folder' }) },
    { id: 'upload-files', label: 'Upload files', run: () => fileInputRef.current?.click() },
    { id: 'upload-folder', label: 'Upload folder', run: () => folderInputRef.current?.click() },
    { id: 'go-my-drive', label: 'Go to My Drive', run: goRoot },
    { id: 'go-starred', label: 'Go to Starred', run: () => setView('starred') },
    { id: 'go-recent', label: 'Go to Recent', run: () => setView('recent') },
    { id: 'go-shared', label: 'Go to Shared with me', run: () => setView('shared-with-me') },
    { id: 'go-trash', label: 'Go to Trash', run: () => setView('trash') },
    { id: 'settings', label: 'Open Settings', run: () => setModal({ type: 'settings' }) },
    { id: 'storage', label: 'Storage details', run: () => setModal({ type: 'storage' }) },
    ...(isAdmin
      ? [
          { id: 'users', label: 'Manage users', run: () => setModal({ type: 'users' }) },
          { id: 'backups', label: 'Backups', run: () => setModal({ type: 'backups' }) },
          { id: 'activity', label: 'Activity log', run: () => setModal({ type: 'activity' }) },
        ]
      : []),
    { id: 'logout', label: 'Log out', hint: user?.username, run: logout },
  ];

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
        <button
          className="btn btn-primary btn-block new-btn"
          onClick={() => setModal({ type: 'new-folder' })}
          disabled={sharedMode && viewerRole === 'view'}
        >
          + New folder
        </button>
        <button
          className="btn btn-block"
          onClick={() => fileInputRef.current?.click()}
          disabled={sharedMode && viewerRole === 'view'}
        >
          Upload files
        </button>
        <button
          className="btn btn-block"
          onClick={() => folderInputRef.current?.click()}
          disabled={sharedMode && viewerRole === 'view'}
        >
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
        <input
          ref={versionInputRef}
          type="file"
          style={{ display: 'none' }}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            const target = versionTargetNode.current;
            e.target.value = '';
            versionTargetNode.current = null;
            if (!file || !target) return;
            try {
              await uploadVersion(target.id, file);
              toast.push(`Uploaded a new version of "${target.name}"`, 'success');
              refresh();
              refreshUsage();
            } catch (err) {
              toast.push(err.message, 'error');
            }
          }}
        />
        <nav className="side-nav">
          <button className={`side-nav-item ${view === 'browse' ? 'active' : ''}`} onClick={goRoot}>
            My Drive
          </button>
          <button
            className={`side-nav-item ${view === 'starred' ? 'active' : ''}`}
            onClick={() => setView('starred')}
          >
            Starred
          </button>
          <button
            className={`side-nav-item ${view === 'recent' ? 'active' : ''}`}
            onClick={() => setView('recent')}
          >
            Recent
          </button>
          <button
            className={`side-nav-item ${view === 'shared-with-me' ? 'active' : ''}`}
            onClick={() => setView('shared-with-me')}
          >
            Shared with me
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
          <button className="usage-box" onClick={() => setModal({ type: 'storage' })}>
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
          </button>
        )}
        <div className="admin-links">
          <button className="link-btn" onClick={() => setModal({ type: 'settings' })}>
            Settings
          </button>
          {isAdmin && (
            <>
              <button className="link-btn" onClick={() => setModal({ type: 'users' })}>
                Manage users
              </button>
              <button className="link-btn" onClick={() => setModal({ type: 'backups' })}>
                Backups
              </button>
              <button className="link-btn" onClick={() => setModal({ type: 'activity' })}>
                Activity
              </button>
            </>
          )}
        </div>
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
              <button
                className="link-btn"
                onClick={() => (sharedMode ? setView('shared-with-me') : goRoot())}
              >
                {sharedMode ? 'Shared with me' : 'My Drive'}
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
          {view === 'starred' && (
            <div className="breadcrumb">
              <strong>Starred</strong>
            </div>
          )}
          {view === 'recent' && (
            <div className="breadcrumb">
              <strong>Recent</strong>
            </div>
          )}
          {view === 'shared-with-me' && (
            <div className="breadcrumb">
              <strong>Shared with me</strong>
            </div>
          )}
          <input
            className="search-input"
            placeholder="Search names & file contents… (Ctrl+K)"
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
            <div className="upload-progress-label">
              <span>Uploading… {Math.round(uploadPct * 100)}%</span>
              <span>
                {uploadStats?.bytesPerSecond > 0 && formatSpeed(uploadStats.bytesPerSecond)}
                {uploadStats?.bytesPerSecond > 0 &&
                  uploadStats.totalBytes > uploadStats.loadedBytes &&
                  ` · ${formatDuration((uploadStats.totalBytes - uploadStats.loadedBytes) / uploadStats.bytesPerSecond)} left`}
              </span>
            </div>
            <div className="upload-progress-fill" style={{ width: `${uploadPct * 100}%` }} />
          </div>
        )}

        {downloadStats && (
          <div className="upload-progress">
            <div className="upload-progress-label">
              <span>Preparing download… {formatBytes(downloadStats.loadedBytes)}</span>
              <span>{downloadStats.bytesPerSecond > 0 && formatSpeed(downloadStats.bytesPerSecond)}</span>
            </div>
            <div className="upload-progress-fill upload-progress-indeterminate" />
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
                {!sharedMode && (
                  <>
                    <button className="btn" onClick={() => setModal({ type: 'bundle-share' })}>
                      Share
                    </button>
                    <button className="btn" onClick={() => setModal({ type: 'bulk-move' })}>
                      Move
                    </button>
                  </>
                )}
                {canEditHere && (
                  <button className="btn btn-danger" onClick={bulkTrash}>
                    Move to trash
                  </button>
                )}
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

        {dragActive && !internalDragActive && <div className="drop-overlay">Drop files to upload</div>}

        {loading ? (
          <div className="empty-state">Loading…</div>
        ) : view === 'shared-with-me' ? (
          <div className="shared-list">
            {sharedFolders.length === 0 && (
              <div className="empty-state">Nobody has shared a folder with you yet.</div>
            )}
            {sharedFolders.map((f) => (
              <button key={f.id} className="shared-row" onClick={() => openSharedFolder(f)}>
                <Icon category="folder" size={20} />
                <span className="shared-row-name">{f.name}</span>
                <span className="muted small">Shared by {f.ownerUsername}</span>
                <span className="badge">{f.permission}</span>
              </button>
            ))}
          </div>
        ) : (
          <ItemsList
            items={sortedItems}
            trashView={view === 'trash'}
            onOpen={openItem}
            actions={actions}
            selectedIds={selectedIds}
            onToggleSelect={toggleSelect}
            onToggleSelectAll={toggleSelectAll}
            sortBy={sortBy}
            sortDir={sortDir}
            onSortChange={view === 'browse' || view === 'starred' || view === 'recent' ? onSortChange : undefined}
            onMoveItem={view === 'browse' && !sharedMode ? onMoveItem : undefined}
            viewerRole={viewerRole}
          />
        )}

        {view === 'browse' && hasMore && !loading && (
          <button className="btn load-more-btn" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
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
            const previousParentId = modal.node.parentId;
            await api.patchNode(modal.node.id, { parentId: targetParentId });
            toast.push(`Moved "${modal.node.name}"`, 'success', 6000, {
              label: 'Undo',
              onClick: async () => {
                await api.patchNode(modal.node.id, { parentId: previousParentId });
                refresh();
              },
            });
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
            const originalParents = selectedNodes.map((n) => ({ id: n.id, parentId: n.parentId }));
            await Promise.all(originalParents.map((n) => api.patchNode(n.id, { parentId: targetParentId })));
            toast.push(`Moved ${originalParents.length} item(s)`, 'success', 6000, {
              label: 'Undo',
              onClick: async () => {
                await Promise.all(originalParents.map((n) => api.patchNode(n.id, { parentId: n.parentId })));
                refresh();
              },
            });
            clearSelection();
            closeModal();
            refresh();
          }}
        />
      )}

      {modal?.type === 'share' && (
        <ShareModal node={modal.node} onChanged={refresh} onClose={() => { closeModal(); refresh(); }} />
      )}

      {modal?.type === 'bundle-share' && (
        <BundleShareModal nodeIds={[...selectedIds]} onClose={closeModal} />
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
      {modal?.type === 'backups' && <BackupsModal onClose={closeModal} />}
      {modal?.type === 'activity' && <ActivityModal onClose={closeModal} />}
      {modal?.type === 'settings' && <SettingsModal onClose={closeModal} />}
      {modal?.type === 'storage' && <StorageModal usage={usage} onClose={closeModal} />}

      {modal?.type === 'version-history' && (
        <VersionHistoryModal node={modal.node} onChanged={refresh} onClose={closeModal} />
      )}

      {modal?.type === 'comments' && (
        <CommentsModal node={modal.node} onChanged={refresh} onClose={closeModal} />
      )}

      {modal?.type === 'access' && <AccessModal node={modal.node} onClose={closeModal} />}

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={paletteCommands}
        onSearch={(q) => api.search(q).then((d) => d.items)}
        onSelectFile={openItem}
      />
    </div>
  );
}
