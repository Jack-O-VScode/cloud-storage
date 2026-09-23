import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { allOwnedBy } from '../store.js';
import { diskUsage } from '../lib/paths.js';

const router = Router();

router.get('/usage', requireAuth, async (req, res) => {
  const bytesUsed = allOwnedBy(req.user.id)
    .filter((n) => n.type === 'file' && !n.trashed)
    .reduce((sum, n) => sum + (n.size || 0), 0);
  const bytesTrashed = allOwnedBy(req.user.id)
    .filter((n) => n.type === 'file' && n.trashed)
    .reduce((sum, n) => sum + (n.size || 0), 0);
  const disk = await diskUsage();
  res.json({ bytesUsed, bytesTrashed, disk });
});

export default router;
