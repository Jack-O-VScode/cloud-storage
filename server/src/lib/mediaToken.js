import jwt from 'jsonwebtoken';
import { config } from '../config.js';

const MEDIA_TOKEN_TTL = '15m';

// A short-lived, single-file-scoped token that lets a browser-initiated
// save/download flow fetch a file without the session cookie. This matters
// because some OS-level "save" mechanisms (notably iOS Safari's native
// "Save Video" on an inline <video> player) fetch the file through their
// own request, separate from the page's own cookie jar - cookie-only auth
// makes that request come back unauthenticated and fail silently.
export function signMediaToken(nodeId, userId) {
  return jwt.sign({ sub: nodeId, uid: userId }, config.jwtSecret, { expiresIn: MEDIA_TOKEN_TTL });
}

// Returns the userId the token was issued to, only if it's valid and
// scoped to this exact node - null otherwise.
export function verifyMediaToken(token, nodeId) {
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    return payload.sub === nodeId ? payload.uid : null;
  } catch {
    return null;
  }
}
