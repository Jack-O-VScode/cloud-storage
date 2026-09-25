import { Router } from 'express';
import crypto from 'node:crypto';
const uuid = crypto.randomUUID;
import { getState, save, findUserByUsername, allOwnedBy, logActivity } from '../store.js';
import { requireAuth, requireAdmin, requireFetchHeader, hashPassword } from '../auth.js';

const router = Router();

function publicUser(u) {
  const used = allOwnedBy(u.id)
    .filter((n) => n.type === 'file' && !n.trashed)
    .reduce((sum, n) => sum + (n.size || 0), 0);
  return {
    id: u.id,
    username: u.username,
    isAdmin: u.isAdmin,
    createdAt: u.createdAt,
    bytesUsed: used,
    quotaBytes: u.quotaBytes || null,
  };
}

// null/0 means unlimited; anything else must be a positive integer.
function parseQuotaBytes(raw) {
  if (raw === null || raw === undefined || raw === 0) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined; // invalid
  return Math.floor(n);
}

router.get('/', requireAuth, requireAdmin, (req, res) => {
  res.json({ users: getState().users.map(publicUser) });
});

router.post('/', requireFetchHeader, requireAuth, requireAdmin, (req, res) => {
  const { username, password, isAdmin, quotaBytes } = req.body || {};
  if (!username || !password || password.length < 8) {
    return res.status(400).json({ error: 'Username and an 8+ character password are required' });
  }
  if (findUserByUsername(username)) {
    return res.status(400).json({ error: 'That username is already taken' });
  }
  const parsedQuota = parseQuotaBytes(quotaBytes);
  if (parsedQuota === undefined) {
    return res.status(400).json({ error: 'Quota must be a positive number, or left blank for unlimited' });
  }
  const state = getState();
  const user = {
    id: uuid(),
    username,
    passwordHash: hashPassword(password),
    isAdmin: Boolean(isAdmin),
    createdAt: Date.now(),
    quotaBytes: parsedQuota,
  };
  state.users.push(user);
  logActivity({
    userId: req.user.id,
    username: req.user.username,
    action: 'create_user',
    targetName: user.username,
  });
  save();
  res.status(201).json({ user: publicUser(user) });
});

router.patch('/:id', requireFetchHeader, requireAuth, requireAdmin, (req, res) => {
  const state = getState();
  const user = state.users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { quotaBytes } = req.body || {};
  if (quotaBytes !== undefined) {
    const parsedQuota = parseQuotaBytes(quotaBytes);
    if (parsedQuota === undefined) {
      return res.status(400).json({ error: 'Quota must be a positive number, or left blank for unlimited' });
    }
    user.quotaBytes = parsedQuota;
    logActivity({
      userId: req.user.id,
      username: req.user.username,
      action: 'update_quota',
      targetName: user.username,
      details: parsedQuota ? `${(parsedQuota / (1024 * 1024 * 1024)).toFixed(1)}GB` : 'unlimited',
    });
  }
  save();
  res.json({ user: publicUser(user) });
});

router.delete('/:id', requireFetchHeader, requireAuth, requireAdmin, (req, res) => {
  const state = getState();
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: "You can't delete your own account" });
  }
  const idx = state.users.findIndex((u) => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'User not found' });
  const [removedUser] = state.users.splice(idx, 1);
  logActivity({
    userId: req.user.id,
    username: req.user.username,
    action: 'delete_user',
    targetName: removedUser.username,
  });
  // Leave that user's files/blobs in place on disk rather than silently
  // deleting someone's data as a side effect of an account removal.
  save();
  res.json({ ok: true });
});

export default router;
