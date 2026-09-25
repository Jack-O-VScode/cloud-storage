import { Router } from 'express';
import { requireAuth, requireAdmin } from '../auth.js';
import { getActivity } from '../store.js';

const router = Router();

router.get('/', requireAuth, requireAdmin, (req, res) => {
  res.json({ activity: getActivity(200) });
});

export default router;
