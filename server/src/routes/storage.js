import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { allOwnedBy, findUserById } from '../store.js';
import { diskUsage } from '../lib/paths.js';

const router = Router();

// Mirrors the frontend's mimeCategory() grouping (web/src/utils/format.js)
// so the breakdown chart's labels/colors line up with the icons shown
// everywhere else in the app.
function categoryOf(node) {
  const m = node.mimeType || '';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'application/pdf') return 'pdf';
  if (/zip|tar|rar|7z|gzip/.test(m)) return 'archive';
  if (/word|document/.test(m) || /\.(docx?|odt)$/i.test(node.name)) return 'doc';
  if (/sheet|excel/.test(m) || /\.(xlsx?|csv|ods)$/i.test(node.name)) return 'sheet';
  if (/presentation|powerpoint/.test(m) || /\.(pptx?|odp)$/i.test(node.name)) return 'slides';
  if (m.startsWith('text/') || /\.(txt|md|json|js|jsx|ts|tsx|py|java|go|rs|c|cpp|h|css|html|yml|yaml|sh)$/i.test(node.name))
    return 'code';
  return 'file';
}

router.get('/usage', requireAuth, async (req, res) => {
  const ownFiles = allOwnedBy(req.user.id).filter((n) => n.type === 'file' && !n.trashed);
  const bytesUsed = ownFiles.reduce((sum, n) => sum + (n.size || 0), 0);
  const bytesTrashed = allOwnedBy(req.user.id)
    .filter((n) => n.type === 'file' && n.trashed)
    .reduce((sum, n) => sum + (n.size || 0), 0);

  const byCategory = {};
  for (const n of ownFiles) {
    const cat = categoryOf(n);
    byCategory[cat] = (byCategory[cat] || 0) + (n.size || 0);
  }

  const disk = await diskUsage();
  const quotaBytes = findUserById(req.user.id)?.quotaBytes || null;
  res.json({ bytesUsed, bytesTrashed, byCategory, disk, quotaBytes });
});

export default router;
