import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { getState, findNodeById } from '../store.js';
import { serialize, serializeBundle, isLinkExpired } from './nodes.js';
import { serializeGrant } from './grants.js';

const router = Router();

// Everything the current user is sharing, in one place ("Shared by me"):
// every public link - single-item and multi-item - and every item they've
// given specific people access to.
router.get('/', requireAuth, (req, res) => {
  const uid = req.user.id;
  const state = getState();

  const links = [];
  for (const n of state.nodes) {
    if (n.ownerId !== uid || !n.shareToken || n.trashed) continue;
    links.push({
      kind: 'item',
      token: n.shareToken,
      expiresAt: n.shareExpiresAt || null,
      expired: isLinkExpired(n.shareExpiresAt),
      passwordProtected: Boolean(n.sharePasswordHash),
      uploadEnabled: n.type === 'folder' && Boolean(n.shareUploadEnabled),
      items: [serialize(n, uid)],
    });
  }
  for (const b of state.bundles) {
    if (b.ownerId !== uid) continue;
    const bundle = serializeBundle(b);
    if (!bundle.items.length) continue;
    links.push({ kind: 'bundle', ...bundle });
  }

  const byNode = new Map();
  for (const g of state.grants) {
    const node = findNodeById(g.nodeId);
    if (!node || node.ownerId !== uid || node.trashed) continue;
    let entry = byNode.get(node.id);
    if (!entry) byNode.set(node.id, (entry = { item: serialize(node, uid), grants: [] }));
    entry.grants.push(serializeGrant(g));
  }
  const people = [...byNode.values()].sort((a, b) =>
    a.item.name.localeCompare(b.item.name, undefined, { sensitivity: 'base' })
  );

  links.sort((a, b) => (a.items[0]?.name || '').localeCompare(b.items[0]?.name || '', undefined, { sensitivity: 'base' }));
  res.json({ links, people });
});

export default router;
