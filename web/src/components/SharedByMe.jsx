import React, { useCallback, useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { mimeCategory } from '../utils/format.js';
import { linkUrl } from './ShareDialog.jsx';

const PERMISSION_SHORT = { view: 'view', upload: 'add files', edit: 'edit' };

function formatDay(ts) {
  return new Date(ts).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

function ItemLabel({ item, onOpen }) {
  return (
    <button className="shared-item-name link-btn" onClick={() => onOpen(item)} title={`Open ${item.name}`}>
      <Icon category={mimeCategory(item)} size={18} />
      <span>{item.name}</span>
    </button>
  );
}

// "Shared by me": every public link (single-item and multi-item) and
// everything shared with specific people, each with a way to change or
// stop it - so nothing shared is ever forgotten about and left open.
export default function SharedByMe({ onOpenItem, onManage, toast, refreshKey }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api
      .listShares()
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const copy = async (token) => {
    try {
      await navigator.clipboard.writeText(linkUrl(token));
      toast.push('Link copied', 'success');
    } catch (err) {
      toast.push(err.message, 'error');
    }
  };

  const turnOff = async (link) => {
    try {
      if (link.kind === 'bundle') await api.deleteShareBundle(link.id);
      else await api.unshare(link.items[0].id);
      toast.push('Link turned off', 'success');
      load();
    } catch (err) {
      toast.push(err.message, 'error');
    }
  };

  if (error) return <div className="empty-state">{error}</div>;
  if (!data) return <div className="empty-state">Loading…</div>;
  if (!data.links.length && !data.people.length) {
    return (
      <div className="empty-state">
        You're not sharing anything yet. Use <strong>Share…</strong> on any file or folder.
      </div>
    );
  }

  return (
    <div className="shared-by-me">
      <section>
        <h3 className="shared-heading">Links ({data.links.length})</h3>
        {!data.links.length && <p className="muted small shared-empty">No public links.</p>}
        {data.links.map((link) => (
          <div key={link.token} className={`shared-card ${link.expired ? 'expired' : ''}`}>
            <div className="shared-card-main">
              {link.kind === 'bundle' ? (
                <div className="shared-bundle-names">
                  <span className="badge">{link.items.length} items</span>
                  {link.items.slice(0, 3).map((i) => (
                    <ItemLabel key={i.id} item={i} onOpen={onOpenItem} />
                  ))}
                  {link.items.length > 3 && <span className="muted small">+{link.items.length - 3} more</span>}
                </div>
              ) : (
                <ItemLabel item={link.items[0]} onOpen={onOpenItem} />
              )}
              <div className="shared-chips">
                {link.expired ? (
                  <span className="chip chip-danger">Expired {formatDay(link.expiresAt)}</span>
                ) : link.expiresAt ? (
                  <span className="chip">Until {formatDay(link.expiresAt)}</span>
                ) : (
                  <span className="chip">No expiry</span>
                )}
                {link.passwordProtected && <span className="chip">Password</span>}
                {link.uploadEnabled && <span className="chip">Visitors can upload</span>}
              </div>
            </div>
            <div className="shared-card-actions">
              <button className="btn" onClick={() => copy(link.token)} disabled={link.expired}>
                Copy link
              </button>
              <button
                className="btn"
                onClick={() => (link.kind === 'bundle' ? onManage(link.items, link) : onManage(link.items))}
              >
                Settings
              </button>
              <button className="link-btn danger" onClick={() => turnOff(link)}>
                Turn off
              </button>
            </div>
          </div>
        ))}
      </section>

      <section>
        <h3 className="shared-heading">People ({data.people.length})</h3>
        {!data.people.length && <p className="muted small shared-empty">Nothing shared with specific people.</p>}
        {data.people.map(({ item, grants }) => (
          <div key={item.id} className="shared-card">
            <div className="shared-card-main">
              <ItemLabel item={item} onOpen={onOpenItem} />
              <div className="shared-chips">
                {grants.map((g) => (
                  <span key={g.id} className="chip">
                    {g.granteeUsername} · {PERMISSION_SHORT[g.permission] || g.permission}
                  </span>
                ))}
              </div>
            </div>
            <div className="shared-card-actions">
              <button className="btn" onClick={() => onManage([item])}>
                Manage
              </button>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
