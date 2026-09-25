import { Router } from 'express';
import crypto from 'node:crypto';
const uuid = crypto.randomUUID;
import rateLimit from 'express-rate-limit';
import { getState, save, findUserByUsername, logActivity } from '../store.js';
import {
  hashPassword,
  verifyPassword,
  issueToken,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  requireFetchHeader,
} from '../auth.js';

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, try again later' },
});

function publicUser(u) {
  return { id: u.id, username: u.username, isAdmin: u.isAdmin, createdAt: u.createdAt };
}

router.get('/setup-needed', (req, res) => {
  res.json({ setupNeeded: getState().users.length === 0 });
});

router.post('/setup', requireFetchHeader, (req, res) => {
  const state = getState();
  if (state.users.length > 0) {
    return res.status(400).json({ error: 'Setup already completed' });
  }
  const { username, password } = req.body || {};
  if (!username || !password || password.length < 8) {
    return res.status(400).json({ error: 'Username and an 8+ character password are required' });
  }
  const user = {
    id: uuid(),
    username,
    passwordHash: hashPassword(password),
    isAdmin: true,
    createdAt: Date.now(),
  };
  state.users.push(user);
  save();
  const token = issueToken(user);
  setSessionCookie(res, token);
  res.json({ user: publicUser(user) });
});

router.post('/login', requireFetchHeader, loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  const user = username && findUserByUsername(username);
  if (!user || !verifyPassword(password || '', user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  logActivity({ userId: user.id, username: user.username, action: 'login' });
  save();
  const token = issueToken(user);
  setSessionCookie(res, token);
  res.json({ user: publicUser(user) });
});

router.post('/logout', requireFetchHeader, requireAuth, (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

export default router;
