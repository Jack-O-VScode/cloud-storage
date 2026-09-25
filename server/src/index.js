import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { loadStore } from './store.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import nodeRoutes from './routes/nodes.js';
import shareRoutes from './routes/share.js';
import storageRoutes from './routes/storage.js';
import backupRoutes from './routes/backups.js';
import activityRoutes from './routes/activity.js';
import { scheduleTrashSweep } from './lib/trashSweep.js';
import { scheduleMetadataBackups } from './lib/backup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

loadStore();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: false, // the SPA is same-origin; CSP tuning can come later if needed
    crossOriginResourcePolicy: { policy: 'same-site' },
  })
);
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/nodes', nodeRoutes);
app.use('/api/share', shareRoutes);
app.use('/api/storage', storageRoutes);
app.use('/api/backups', backupRoutes);
app.use('/api/activity', activityRoutes);

scheduleTrashSweep();
scheduleMetadataBackups();

app.get('/api/health', (req, res) => res.json({ ok: true }));

const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir, { index: false }));
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large' || err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File too large' });
  }
  if (err?.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(413).json({ error: 'Too many files in this upload at once' });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(config.port, () => {
  console.log(`cloud-storage server listening on port ${config.port} (data dir: ${config.dataDir})`);
});

// Node's default requestTimeout (5 minutes) caps how long a single request
// is allowed to take from start to finish - a large file upload on a slow
// connection easily exceeds that, silently killing the transfer partway
// through with no file ending up saved. Give uploads several hours instead.
server.requestTimeout = 6 * 60 * 60 * 1000;
