import { config } from '../config.js';
import { getState, save, logActivity } from '../store.js';
import { purgeNodeBlob } from './purge.js';

export async function sweepTrash() {
  if (!config.trashAutoEmptyDays) return;
  const cutoff = Date.now() - config.trashAutoEmptyDays * 24 * 60 * 60 * 1000;
  const state = getState();
  const toRemove = state.nodes.filter((n) => n.trashed && n.trashedAt && n.trashedAt < cutoff);
  if (!toRemove.length) return;

  await Promise.all(toRemove.map((n) => purgeNodeBlob(n)));
  const removeIds = new Set(toRemove.map((n) => n.id));
  state.nodes = state.nodes.filter((n) => !removeIds.has(n.id));
  logActivity({
    action: 'auto_empty_trash',
    targetName: `${toRemove.length} item(s)`,
    details: `older than ${config.trashAutoEmptyDays} days`,
  });
  await save();
  console.log(
    `[trash-sweep] permanently deleted ${toRemove.length} item(s) older than ${config.trashAutoEmptyDays} days`
  );
}

export function scheduleTrashSweep() {
  if (!config.trashAutoEmptyDays) return;
  const run = () => sweepTrash().catch((err) => console.error('[trash-sweep] failed:', err));
  setTimeout(run, 60 * 1000); // first pass shortly after boot
  setInterval(run, 6 * 60 * 60 * 1000); // then every 6 hours
}
