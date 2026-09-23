import { Router } from 'express';
import crypto from 'node:crypto';
const uuid = crypto.randomUUID;
import { getState, save, findUserByUsername, allOwnedBy } from '../store.js';
import { requireAuth, requireAdmin, requireFetchHeader, hashPassword } from '../auth.js';

const router = Router();

function publicUser(u) {
  const used = allOwnedBy(u.id)
    .filter((n) => n.type === 'file' && !n.trashed)
    .reduce((sum, n) => sum + (n.size || 0), 0);
  return { id: u.id, username: u.username, isAdmin: u.isAdmin, createdAt: u.createdAt, bytesUsed: used };
}

router.get('/', requireAuth, requireAdmin, (req, res) => {
  res.json({ users: getState().users.map(publicUser) });
});

router.post('/', requireFetchHeader, requireAuth, requireAdmin, (req, res) => {
  const { username, password, isAdmin } = req.body || {};
  if (!username || !password || password.length < 8) {
    return res.status(400).json({ error: 'Username and an 8+ character password are required' });
  }
  if (findUserByUsername(username)) {
    return res.status(400).json({ error: 'That username is already taken' });
  }
  const state = getState();
  const user = {
    id: uuid(),
    username,
    passwordHash: hashPassword(password),
    isAdmin: Boolean(isAdmin),
    createdAt: Date.now(),
  };
  state.users.push(user);
  save();
  res.status(201).json({ user: publicUser(user) });
});

router.delete('/:id', requireFetchHeader, requireAuth, requireAdmin, (req, res) => {
  const state = getState();
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: "You can't delete your own account" });
  }
  const idx = state.users.findIndex((u) => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'User not found' });
  state.users.splice(idx, 1);
  // Leave that user's files/blobs in place on disk rather than silently
  // deleting someone's data as a side effect of an account removal.
  save();
  res.json({ ok: true });
});

export default router;
