import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from './config.js';
import { findUserById } from './store.js';

export function hashPassword(password) {
  return bcrypt.hashSync(password, 12);
}

export function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

export function issueToken(user) {
  return jwt.sign({ sub: user.id }, config.jwtSecret, { expiresIn: '30d' });
}

export function setSessionCookie(res, token) {
  res.cookie(config.cookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd && config.forceHttps,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(config.cookieName, { path: '/' });
}

export function requireAuth(req, res, next) {
  const token = req.cookies?.[config.cookieName];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    const user = findUserById(payload.sub);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Session expired' });
  }
}

export function requireAdmin(req, res, next) {
  if (!req.user?.isAdmin) return res.status(403).json({ error: 'Admin only' });
  next();
}

// Lightweight CSRF mitigation: since auth relies on a cookie, require a
// custom header on state-changing requests. Browsers only let same-origin
// (or explicitly CORS-approved) JS set custom headers, so a cross-site
// form/img/script can't trigger this without also passing a CORS preflight.
export function requireFetchHeader(req, res, next) {
  if (req.headers['x-requested-with'] !== 'cloud-storage') {
    return res.status(403).json({ error: 'Missing required header' });
  }
  next();
}
