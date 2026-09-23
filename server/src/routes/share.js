import { Router } from 'express';
import { getState } from '../store.js';
import { streamFile } from './nodes.js';

const router = Router();

function findByShareToken(token) {
  return getState().nodes.find((n) => n.shareToken === token && !n.trashed);
}

// Deliberately unauthenticated: this is the public link. Anyone holding the
// token can view metadata / download, same trust model as Drive's "anyone
// with the link".
router.get('/:token', (req, res) => {
  const node = findByShareToken(req.params.token);
  if (!node) return res.status(404).json({ error: 'Link not found or revoked' });
  res.json({ item: { name: node.name, size: node.size, mimeType: node.mimeType } });
});

router.get('/:token/download', (req, res) => {
  const node = findByShareToken(req.params.token);
  if (!node) return res.status(404).json({ error: 'Link not found or revoked' });
  streamFile(req, res, node);
});

export default router;
