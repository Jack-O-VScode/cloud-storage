import { Router } from 'express';
import { requireAuth, requireAdmin, requireFetchHeader } from '../auth.js';
import { listBackups, createFullBackup, estimateFullBackupSize, backupFilePath } from '../lib/backup.js';
import { diskUsage } from '../lib/paths.js';
import { logActivity, save } from '../store.js';

const router = Router();

router.get('/', requireAuth, requireAdmin, async (req, res) => {
  const [backups, disk, estimatedFullSize] = await Promise.all([
    listBackups(),
    diskUsage(),
    estimateFullBackupSize(),
  ]);
  res.json({ backups, disk, estimatedFullSize });
});

// Runs in the background - a full backup of a large data set can take a
// while, and there's no reason to hold the HTTP request open for it. The
// admin polls the list afterward to see it appear.
router.post('/full', requireFetchHeader, requireAuth, requireAdmin, (req, res) => {
  createFullBackup()
    .then((filename) => {
      logActivity({
        userId: req.user.id,
        username: req.user.username,
        action: 'create_full_backup',
        targetName: filename,
      });
      return save();
    })
    .catch((err) => console.error('[backup] on-demand full backup failed:', err));
  res.status(202).json({ started: true });
});

router.get('/:filename/download', requireAuth, requireAdmin, async (req, res) => {
  const backups = await listBackups();
  const entry = backups.find((b) => b.filename === req.params.filename);
  if (!entry) return res.status(404).json({ error: 'Backup not found' });
  res.download(backupFilePath(entry), entry.filename);
});

export default router;
