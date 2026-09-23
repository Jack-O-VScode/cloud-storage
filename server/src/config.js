import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = process.env.DATA_DIR || path.resolve('./data');
const BLOB_DIR = path.join(DATA_DIR, 'blobs');
const META_FILE = path.join(DATA_DIR, 'metadata.json');
const PORT = parseInt(process.env.PORT || '3000', 10);
const NODE_ENV = process.env.NODE_ENV || 'production';

let jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  // Fall back to a random secret so the app still boots, but this means
  // every restart invalidates existing sessions. Warn loudly so people
  // running this unattended on a Pi notice and set a real secret.
  jwtSecret = crypto.randomBytes(48).toString('hex');
  console.warn(
    '[config] JWT_SECRET is not set. Using a random secret for this process only ' +
      '- all users will be logged out on every restart. Set JWT_SECRET in your .env to avoid this.'
  );
}

export const config = {
  dataDir: DATA_DIR,
  blobDir: BLOB_DIR,
  metaFile: META_FILE,
  port: PORT,
  nodeEnv: NODE_ENV,
  isProd: NODE_ENV === 'production',
  jwtSecret,
  cookieName: 'cs_session',
  maxUploadBytes: parseInt(process.env.MAX_UPLOAD_BYTES || String(20 * 1024 * 1024 * 1024), 10), // 20GB default
  forceHttps: process.env.FORCE_HTTPS === 'true',
};
