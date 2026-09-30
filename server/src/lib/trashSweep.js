import { config } from '../config.js';
import { getState, save, logActivity } from '../store.js';
import { isTopLevelTrashed, removeNodesPermanently } from './trash.js';

export async function sweepTrash() {
  if (!config.trashAutoEmptyDays) return;
  const cutoff = Date.now() - config.trashAutoEmptyDays * 24 * 60 * 60 * 1000;
  const state = getState();
  // Whole trashed items (a folder takes its contents with it), so nothing
  // is ever left behind pointing at a parent that no longer exists.
  const roots = state.nodes.filter((n) => isTopLevelTrashed(n) && n.trashedAt && n.trashedAt < cutoff);
  if (!roots.length) return;
  const removedCount = await removeNodesPermanently(roots);
  logActivity({
    action: 'auto_empty_trash',
    targetName: `${removedCount} item(s)`,
    details: `older than ${config.trashAutoEmptyDays} days`,
  });
  await save();
  console.log(
    `[trash-sweep] permanently deleted ${removedCount} item(s) older than ${config.trashAutoEmptyDays} days`
  );
}

export function scheduleTrashSweep() {
  if (!config.trashAutoEmptyDays) return;
  const run = () => sweepTrash().catch((err) => console.error('[trash-sweep] failed:', err));
  setTimeout(run, 60 * 1000); // first pass shortly after boot
  setInterval(run, 6 * 60 * 60 * 1000); // then every 6 hours
}
