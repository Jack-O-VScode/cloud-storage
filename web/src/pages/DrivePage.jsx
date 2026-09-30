import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, downloadZip } from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../components/Toasts.jsx';
import ItemsList from '../components/ItemsList.jsx';
import TextPromptModal from '../components/TextPromptModal.jsx';
import MoveModal from '../components/MoveModal.jsx';
import ShareDialog, { linkUrl } from '../components/ShareDialog.jsx';
import SharedByMe from '../components/SharedByMe.jsx';
import ConflictDialog from '../components/ConflictDialog.jsx';
import PreviewModal from '../components/PreviewModal.jsx';
import UsersAdminModal from '../components/UsersAdminModal.jsx';
import BackupsModal from '../components/BackupsModal.jsx';
import ActivityModal from '../components/ActivityModal.jsx';
import SettingsModal from '../components/SettingsModal.jsx';
import StorageModal from '../components/StorageModal.jsx';
import CommandPalette from '../components/CommandPalette.jsx';
import VersionHistoryModal from '../components/VersionHistoryModal.jsx';
import CommentsModal from '../components/CommentsModal.jsx';
import { ConfirmDialog } from '../components/Modal.jsx';
import { enqueue, onUploadComplete } from '../uploads/uploadManager.js';
import { formatBytes, formatSpeed } from '../utils/format.js';
import { filesToEntries, collectFilesFromDataTransfer } from '../utils/collectFiles.js';

const PAGE_SIZE = 200;

const VIEW_TITLES = {
  starred: 'Starred',
  recent: 'Recent',
  'shared-with-me': 'Shared with me',
  'shared-by-me': 'Shared by me',
  search: 'Search results',
};

const EMPTY_MESSAGES = {
  starred: 'Nothing starred yet - tap ☆ next to anything you want to keep handy.',
  recent: 'No files yet.',
  'shared-with-me': 'Nobody has shared anything with you yet.',
  search: 'No matches.',
};

const canEditRole = (access) => access === 'owner' || access === 'edit';
const canUploadRole = (access) => access === 'owner' || access === 'edit' || access === 'upload';

export default function DrivePage() {
  const { user, logout } = useAuth();
  const toast = useToast();

  const [view, setView] = useState('browse'); // browse | trash | search | starred | recent | shared-with-me | shared-by-me
  const [parentId, setParentId] = useState('root');
  const [breadcrumb, setBreadcrumb] = useState([]);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  // What the signed-in user may do in the folder being browsed, as reported
  // by the server for that folder: 'owner' in their own drive, else the
  // level someone granted them (view / upload / edit).
  const [folderAccess, setFolderAccess] = useState('owner');
  const [folderOwner, setFolderOwner] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [usage, setUsage] = useState(null);
  const [dragActive, setDragActive] = useState(false);
  const [downloadStats, setDownloadStats] = useState(null); // { loadedBytes, bytesPerSecond } | null

  const [modal, setModal] = useState(null); // { type, node?, items?, bundle? }
  const [conflictPrompt, setConflictPrompt] = useState(null); // { conflicts, canReplace, resolve }
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [sortBy, setSortBy] = useState('name');
  const [sortDir, setSortDir] = useState('asc');
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [internalDragActive, setInternalDragActive] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sharesRefreshKey, setSharesRefreshKey] = useState(0);
  // Phone layout: the sidebar becomes a slide-out drawer.
  const [navOpen, setNavOpen] = useState(false);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  // Which view/folder the items currently on screen belong to - "Loading…"
  // only replaces the list when switching somewhere new, not on every
  // background refresh (e.g. each time an upload finishes).
  const [loadedKey, setLoadedKey] = useState(null);
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const versionInputRef = useRef(null);
  const versionTargetNode = useRef(null);
  const dragCounter = useRef(0);
  const loadMoreRef = useRef(null);

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

  const viewKey = `${view}|${parentId}|${view === 'search' ? searchQuery : ''}`;

  const refresh = useCallback(async () => {
    if (view === 'shared-by-me') {
      setLoading(false);
      return;
    }
    const key = `${view}|${parentId}|${view === 'search' ? searchQuery : ''}`;
    setLoading(true);
    try {
      let data;
      if (view === 'trash') data = await api.listTrash();
      else if (view === 'search') data = await api.search(searchQuery);
      else if (view === 'starred') data = await api.listStarred();
      else if (view === 'recent') data = await api.listRecent();
      else if (view === 'shared-with-me') data = await api.listSharedWithMe();
      else {
        // Sorting happens server-side (so "Load more" keeps paging through
        // one consistent order) - a fresh browse fetch always starts back
        // at the top of the folder.
        data = await api.listNodes(parentId, { sortBy, sortDir, offset: 0, limit: PAGE_SIZE });
        setBreadcrumb(data.breadcrumb);
        setHasMore(data.hasMore);
        setFolderAccess(data.access || 'owner');
        setFolderOwner(data.ownerUsername || null);
      }
      setItems(data.items);
      setLoadedKey(key);
      if (view !== 'browse') {
        setBreadcrumb([]);
        setHasMore(false);
      }
    } catch (err) {
      toast.push(err.message, 'error');
      // The folder vanished (deleted, or access taken away) - don't leave
      // the user staring at an error on a dead page.
      if (view === 'browse' && parentId !== 'root' && (err.status === 400 || err.status === 404)) {
        setParentId('root');
      }
    } finally {
      setLoading(false);
    }
  }, [view, parentId, searchQuery, sortBy, sortDir]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const loadMore = useCallback(async () => {
    if (view !== 'browse' || loadingMore || !hasMore) return;
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
  }, [view, loadingMore, hasMore, parentId, sortBy, sortDir, items.length]);

  // Big folders load the next page automatically as you scroll near the
  // end, instead of new uploads seeming to "vanish" past page one.
  useEffect(() => {
    const el = loadMoreRef.current;
    if (!el || !hasMore) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMore();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, loadMore]);

  const refreshUsage = useCallback(() => {
    api.usage().then(setUsage).catch(() => {});
  }, []);

  useEffect(() => {
    refreshUsage();
  }, [refreshUsage]);

  // Each file that finishes uploading (from anywhere in the queue) refreshes
  // the listing - batched, so a folder of 500 photos doesn't mean 500 reloads.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    let timer = null;
    const off = onUploadComplete(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        refreshRef.current();
        refreshUsage();
      }, 600);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [refreshUsage]);

  const goRoot = () => {
    setView('browse');
    setParentId('root');
    setSearchQuery('');
  };

  const openFolder = (id) => {
    setView('browse');
    setParentId(id);
    setSearchQuery('');
  };

  const fileSiblings = items.filter((i) => i.type === 'file');

  const openItem = (node) => {
    if (node.type === 'folder') openFolder(node.id);
    else setModal({ type: 'preview', node });
  };

  // Where an upload / new folder goes: the folder being browsed, or - from
  // any other view (Starred, Recent, Search, ...) - the top of My Drive.
  const uploadTarget = () => {
    if (view === 'browse') {
      const current = breadcrumb[breadcrumb.length - 1];
      return {
        parentId,
        access: folderAccess,
        label: current ? current.name : 'My Drive',
      };
    }
    return { parentId: 'root', access: 'owner', label: 'My Drive' };
  };

  // Resolves to Map<index, 'replace'|'rename'|'skip'>, or null if the user
  // cancelled the whole upload from the conflict prompt.
  const askAboutConflicts = (conflicts, canReplace) =>
    new Promise((resolve) => setConflictPrompt({ conflicts, canReplace, resolve }));

  // `entries` is [{file, relativePath}] - relativePath is empty for a flat
  // file upload, or e.g. "Photos/2024/img.jpg" when uploading a folder, so
  // the server can recreate the folder structure instead of flattening it.
  const startUpload = async (entries) => {
    if (!entries.length) return;
    const target = uploadTarget();
    if (!canUploadRole(target.access)) {
      toast.push('You can only view this folder - ask its owner for upload access.', 'error');
      return;
    }

    let decisions = new Map();
    try {
      const { conflicts } = await api.checkConflicts(
        target.parentId,
        entries.map((e) => e.relativePath || e.file.name)
      );
      if (conflicts.length) {
        const withFiles = conflicts.map((c) => ({ ...c, file: entries[c.index].file }));
        decisions = await askAboutConflicts(withFiles, canEditRole(target.access));
        setConflictPrompt(null);
        if (!decisions) return;
      }
    } catch {
      // Couldn't check - upload anyway; the server keeps both on a clash.
    }

    const queued = [];
    entries.forEach((entry, i) => {
      const decision = decisions.get(i);
      if (decision === 'skip') return;
      const dir = entry.relativePath ? entry.relativePath.split('/').slice(0, -1).join('/') : '';
      queued.push({
        file: entry.file,
        relativePath: entry.relativePath || '',
        targetLabel: dir ? `${target.label} › ${dir.replace(/\//g, ' › ')}` : target.label,
        initBody: { parentId: target.parentId, onConflict: decision === 'replace' ? 'replace' : 'rename' },
      });
    });
    if (!queued.length) return;
    enqueue(queued);
    if (view !== 'browse') toast.push(`Uploading to My Drive`, 'info');
  };

  // Drag-and-drop upload (files or whole folders) anywhere over the content area.
  const canDropHere = view === 'browse' && canUploadRole(folderAccess);
  const onDragEnter = (e) => {
    e.preventDefault();
    if (!canDropHere) return;
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
    if (!canDropHere || internalDragActive) return;
    const entries = await collectFilesFromDataTransfer(e.dataTransfer);
    if (entries.length) startUpload(entries);
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
    view === 'browse' || view === 'trash'
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

  const guard = (fn) => async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      toast.push(err.message, 'error');
    }
  };

  const actions = {
    open: openItem,
    download: guard(async (node) => {
      if (node.type === 'folder') {
        setDownloadStats({ loadedBytes: 0, bytesPerSecond: 0 });
        try {
          await downloadZip([node.id], setDownloadStats);
        } finally {
          setDownloadStats(null);
        }
      } else {
        const a = document.createElement('a');
        a.href = api.downloadUrl(node.id);
        a.click();
      }
    }),
    share: (node) => setModal({ type: 'share', items: [node] }),
    // Copies an existing link straight away; with no link yet, opens the
    // Share dialog instead - nothing becomes public without you seeing it.
    copyLink: guard(async (node) => {
      if (node.shareToken && !node.shareExpired) {
        await navigator.clipboard.writeText(linkUrl(node.shareToken));
        toast.push('Link copied', 'success');
      } else {
        setModal({ type: 'share', items: [node] });
      }
    }),
    rename: (node) => setModal({ type: 'rename', node }),
    move: (node) => setModal({ type: 'move', node, excludeIds: new Set([node.id]) }),
    trash: guard(async (node) => {
      await api.patchNode(node.id, { trashed: true });
      toast.push(`Moved "${node.name}" to trash`, 'success', 6000, {
        label: 'Undo',
        onClick: guard(async () => {
          await api.patchNode(node.id, { trashed: false });
          refresh();
          refreshUsage();
        }),
      });
      refresh();
      refreshUsage();
    }),
    restore: guard(async (node) => {
      await api.patchNode(node.id, { trashed: false });
      toast.push(`Restored "${node.name}"`, 'success');
      refresh();
      refreshUsage();
    }),
    deleteForever: (node) => setModal({ type: 'delete-forever', node }),
    toggleStar: guard(async (node) => {
      await api.patchNode(node.id, { starred: !node.starred });
      refresh();
    }),
    uploadVersion: (node) => {
      versionTargetNode.current = node;
      versionInputRef.current?.click();
    },
    versionHistory: (node) => setModal({ type: 'version-history', node }),
    comments: (node) => setModal({ type: 'comments', node }),
    leaveShare: guard(async (node) => {
      await api.deleteGrant(node.grantId);
      toast.push(`Removed "${node.name}" from Shared with me`, 'success');
      refresh();
    }),
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
  const allSelectedOwned = selectedNodes.length > 0 && selectedNodes.every((n) => (n.access || 'owner') === 'owner');
  const allSelectedEditable = selectedNodes.length > 0 && selectedNodes.every((n) => canEditRole(n.access || 'owner'));

  const bulkDownload = guard(async () => {
    setDownloadStats({ loadedBytes: 0, bytesPerSecond: 0 });
    try {
      await downloadZip([...selectedIds], setDownloadStats);
    } finally {
      setDownloadStats(null);
    }
  });
  const bulkTrash = guard(async () => {
    const targets = selectedNodes;
    await Promise.all(targets.map((n) => api.patchNode(n.id, { trashed: true })));
    toast.push(`Moved ${targets.length} item(s) to trash`, 'success', 6000, {
      label: 'Undo',
      onClick: guard(async () => {
        await Promise.all(targets.map((n) => api.patchNode(n.id, { trashed: false })));
        refresh();
        refreshUsage();
      }),
    });
    clearSelection();
    refresh();
    refreshUsage();
  });
  const bulkRestore = guard(async () => {
    await Promise.all(selectedNodes.map((n) => api.patchNode(n.id, { trashed: false })));
    toast.push(`Restored ${selectedNodes.length} item(s)`, 'success');
    clearSelection();
    refresh();
    refreshUsage();
  });

  const closeModal = () => setModal(null);
  const onSharingChanged = useCallback(() => {
    refreshRef.current();
    setSharesRefreshKey((k) => k + 1);
  }, []);

  const isAdmin = user?.isAdmin;
  const uploadDisabled = view === 'browse' && !canUploadRole(folderAccess);
  const target = uploadTarget();

  const searchFiles = useCallback((q) => api.search(q).then((d) => d.items), []);

  const mobileTitle =
    view === 'browse'
      ? breadcrumb[breadcrumb.length - 1]?.name || (folderAccess === 'owner' ? 'My Drive' : 'Shared with me')
      : view === 'trash'
      ? 'Trash'
      : VIEW_TITLES[view];

  const paletteCommands = [
    { id: 'new-folder', label: 'New folder', run: () => setModal({ type: 'new-folder' }) },
    { id: 'upload-files', label: 'Upload files', run: () => fileInputRef.current?.click() },
    { id: 'upload-folder', label: 'Upload folder', run: () => folderInputRef.current?.click() },
    { id: 'go-my-drive', label: 'Go to My Drive', run: goRoot },
    { id: 'go-starred', label: 'Go to Starred', run: () => setView('starred') },
    { id: 'go-recent', label: 'Go to Recent', run: () => setView('recent') },
    { id: 'go-shared', label: 'Go to Shared with me', run: () => setView('shared-with-me') },
    { id: 'go-shared-by-me', label: 'Go to Shared by me', run: () => setView('shared-by-me') },
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

  const navButton = (key, label) => (
    <button
      className={`side-nav-item ${view === key ? 'active' : ''}`}
      onClick={() => {
        setSearchQuery('');
        setView(key);
      }}
    >
      {label}
    </button>
  );

  return (
    <div
      className="app-shell"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {navOpen && <div className="sidebar-backdrop" onClick={() => setNavOpen(false)} />}
      <aside
        className={`sidebar ${navOpen ? 'open' : ''}`}
        onClickCapture={(e) => {
          // Any choice made in the drawer closes it.
          if (e.target.closest('button')) setNavOpen(false);
        }}
      >
        <div className="brand">☁️ Cloud Storage</div>
        <button
          className="btn btn-primary btn-block new-btn"
          onClick={() => setModal({ type: 'new-folder' })}
          disabled={uploadDisabled}
          title={uploadDisabled ? 'You can only view this folder' : undefined}
        >
          + New folder
        </button>
        <button
          className="btn btn-block"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploadDisabled}
          title={uploadDisabled ? 'You can only view this folder' : undefined}
        >
          Upload files
        </button>
        <button
          className="btn btn-block"
          onClick={() => folderInputRef.current?.click()}
          disabled={uploadDisabled}
          title={uploadDisabled ? 'You can only view this folder' : undefined}
        >
          Upload folder
        </button>
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
            startUpload(filesToEntries(e.target.files));
            e.target.value = '';
          }}
        />
        <input
          ref={versionInputRef}
          type="file"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            const node = versionTargetNode.current;
            e.target.value = '';
            versionTargetNode.current = null;
            if (!file || !node) return;
            enqueue([{ file, targetLabel: `new version of “${node.name}”`, initBody: { replaceNodeId: node.id } }]);
          }}
        />
        <nav className="side-nav">
          <button className={`side-nav-item ${view === 'browse' && folderAccess === 'owner' ? 'active' : ''}`} onClick={goRoot}>
            My Drive
          </button>
          {navButton('starred', 'Starred')}
          {navButton('recent', 'Recent')}
          <button
            className={`side-nav-item ${view === 'shared-with-me' || (view === 'browse' && folderAccess !== 'owner') ? 'active' : ''}`}
            onClick={() => {
              setSearchQuery('');
              setView('shared-with-me');
            }}
          >
            Shared with me
          </button>
          {navButton('shared-by-me', 'Shared by me')}
          {navButton('trash', 'Trash')}
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
        <div className="mobile-header">
          <button className="icon-btn mobile-menu-btn" onClick={() => setNavOpen(true)} aria-label="Open menu">
            ☰
          </button>
          <span className="mobile-title">{mobileTitle}</span>
          <div className="mobile-new">
            <button
              className="btn btn-primary"
              onClick={() => setNewMenuOpen((o) => !o)}
              disabled={uploadDisabled}
              aria-haspopup="menu"
            >
              + New
            </button>
            {newMenuOpen && (
              <>
                <div className="menu-dismiss" onClick={() => setNewMenuOpen(false)} />
                <div className="row-menu mobile-new-menu" role="menu">
                  {[
                    ['New folder', () => setModal({ type: 'new-folder' })],
                    ['Upload files', () => fileInputRef.current?.click()],
                    ['Upload folder', () => folderInputRef.current?.click()],
                  ].map(([label, run]) => (
                    <button
                      key={label}
                      onClick={() => {
                        setNewMenuOpen(false);
                        run();
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
        <div className="top-bar">
          {view === 'browse' && (
            <div className="breadcrumb">
              <button
                className="link-btn"
                onClick={() => (folderAccess !== 'owner' ? setView('shared-with-me') : goRoot())}
              >
                {folderAccess !== 'owner' ? 'Shared with me' : 'My Drive'}
              </button>
              {breadcrumb.map((b) => (
                <React.Fragment key={b.id}>
                  <span> / </span>
                  <button className="link-btn" onClick={() => openFolder(b.id)}>
                    {b.name}
                  </button>
                </React.Fragment>
              ))}
              {folderAccess !== 'owner' && (
                <span className="badge" title={folderOwner ? `Owned by ${folderOwner}` : undefined}>
                  {folderOwner ? `${folderOwner}'s · ` : ''}
                  {folderAccess === 'view' ? 'view only' : folderAccess === 'upload' ? 'can add files' : 'can edit'}
                </span>
              )}
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
          {VIEW_TITLES[view] && (
            <div className="breadcrumb">
              <strong>{VIEW_TITLES[view]}</strong>
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

        {downloadStats && (
          <div className="upload-progress">
            <div className="upload-progress-label">
              <span>Preparing download… {formatBytes(downloadStats.loadedBytes)}</span>
              <span>{downloadStats.bytesPerSecond > 0 && formatSpeed(downloadStats.bytesPerSecond)}</span>
            </div>
            <div className="upload-progress-fill upload-progress-indeterminate" />
          </div>
        )}

        {view === 'trash' && items.length > 0 && usage?.trashAutoEmptyDays > 0 && (
          <p className="muted small view-note">
            Items in the trash are deleted forever after {usage.trashAutoEmptyDays} days.
          </p>
        )}

        {selectedIds.size > 0 && (
          <div className="selection-bar">
            <span>{selectedIds.size} selected</span>
            {view !== 'trash' ? (
              <>
                <button className="btn" onClick={bulkDownload}>
                  Download
                </button>
                {allSelectedOwned && (
                  <>
                    <button className="btn" onClick={() => setModal({ type: 'share', items: selectedNodes })}>
                      Share…
                    </button>
                    <button className="btn" onClick={() => setModal({ type: 'bulk-move' })}>
                      Move
                    </button>
                  </>
                )}
                {allSelectedEditable && (
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

        {dragActive && !internalDragActive && (
          <div className="drop-overlay">Drop files to upload to “{target.label}”</div>
        )}

        {view === 'shared-by-me' ? (
          <SharedByMe
            refreshKey={sharesRefreshKey}
            toast={toast}
            onOpenItem={openItem}
            onManage={(shareItems, bundle) => setModal({ type: 'share', items: shareItems, bundle })}
          />
        ) : loading && loadedKey !== viewKey ? (
          <div className="empty-state">Loading…</div>
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
            onSortChange={view !== 'trash' ? onSortChange : undefined}
            onMoveItem={view === 'browse' && canEditRole(folderAccess) ? onMoveItem : undefined}
            emptyMessage={
              view === 'browse' && canUploadRole(folderAccess)
                ? 'This folder is empty - drop files here or use Upload.'
                : EMPTY_MESSAGES[view]
            }
          />
        )}

        {view === 'browse' && hasMore && (
          <div ref={loadMoreRef} className="load-more-sentinel">
            <button className="btn load-more-btn" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </main>

      {conflictPrompt && (
        <ConflictDialog
          conflicts={conflictPrompt.conflicts}
          canReplace={conflictPrompt.canReplace}
          onDone={(decisions) => conflictPrompt.resolve(decisions)}
          onCancel={() => {
            conflictPrompt.resolve(null);
            setConflictPrompt(null);
          }}
        />
      )}

      {modal?.type === 'new-folder' && (
        <TextPromptModal
          title={view === 'browse' ? `New folder in “${target.label}”` : 'New folder in My Drive'}
          label="Folder name"
          confirmLabel="Create"
          onCancel={closeModal}
          onSubmit={async (name) => {
            await api.createFolder(name, target.parentId);
            closeModal();
            if (view === 'browse') refresh();
            else goRoot();
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
          excludeIds={modal.excludeIds}
          onCancel={closeModal}
          onMove={guard(async (targetParentId) => {
            const previousParentId = modal.node.parentId;
            await api.patchNode(modal.node.id, { parentId: targetParentId });
            toast.push(`Moved "${modal.node.name}"`, 'success', 6000, {
              label: 'Undo',
              onClick: guard(async () => {
                await api.patchNode(modal.node.id, { parentId: previousParentId });
                refresh();
              }),
            });
            closeModal();
            refresh();
          })}
        />
      )}

      {modal?.type === 'bulk-move' && (
        <MoveModal
          title={`Move ${selectedIds.size} items`}
          excludeIds={selectedIds}
          onCancel={closeModal}
          onMove={guard(async (targetParentId) => {
            const originalParents = selectedNodes.map((n) => ({ id: n.id, parentId: n.parentId }));
            await Promise.all(originalParents.map((n) => api.patchNode(n.id, { parentId: targetParentId })));
            toast.push(`Moved ${originalParents.length} item(s)`, 'success', 6000, {
              label: 'Undo',
              onClick: guard(async () => {
                await Promise.all(originalParents.map((n) => api.patchNode(n.id, { parentId: n.parentId })));
                refresh();
              }),
            });
            clearSelection();
            closeModal();
            refresh();
          })}
        />
      )}

      {modal?.type === 'share' && (
        <ShareDialog items={modal.items} bundle={modal.bundle} onChanged={onSharingChanged} onClose={closeModal} />
      )}

      {modal?.type === 'preview' && (
        <PreviewModal
          node={modal.node}
          siblings={fileSiblings}
          onNavigate={(node) => setModal({ type: 'preview', node })}
          onClose={closeModal}
        />
      )}

      {modal?.type === 'delete-forever' && (
        <ConfirmDialog
          title="Delete forever"
          message={`Permanently delete "${modal.node.name}"${modal.node.type === 'folder' ? ' and everything in it' : ''}? This can't be undone.`}
          confirmLabel="Delete forever"
          danger
          onCancel={closeModal}
          onConfirm={guard(async () => {
            await api.deleteNode(modal.node.id);
            closeModal();
            refresh();
            refreshUsage();
          })}
        />
      )}

      {modal?.type === 'bulk-delete-forever' && (
        <ConfirmDialog
          title="Delete forever"
          message={`Permanently delete ${selectedNodes.length} item(s)? This can't be undone.`}
          confirmLabel="Delete forever"
          danger
          onCancel={closeModal}
          onConfirm={guard(async () => {
            await Promise.all(selectedNodes.map((n) => api.deleteNode(n.id)));
            clearSelection();
            closeModal();
            refresh();
            refreshUsage();
          })}
        />
      )}

      {modal?.type === 'empty-trash' && (
        <ConfirmDialog
          title="Empty trash"
          message="Permanently delete everything in the trash? This can't be undone."
          confirmLabel="Empty trash"
          danger
          onCancel={closeModal}
          onConfirm={guard(async () => {
            await api.emptyTrash();
            closeModal();
            refresh();
            refreshUsage();
          })}
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

      {modal?.type === 'comments' && <CommentsModal node={modal.node} onChanged={refresh} onClose={closeModal} />}

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={paletteCommands}
        onSearch={searchFiles}
        onSelectFile={openItem}
      />
    </div>
  );
}
