import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ZipArchive } from 'archiver';
import { config } from '../config.js';

function timestampName() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

const metadataBackupDir = () => path.join(config.backupDir, 'metadata');

// Metadata backups are just a timestamped copy of metadata.json - tiny, so
// keeping many of them costs almost nothing. They protect against the one
// thing that would be catastrophic to lose: the file tree/names/sharing
// state (the raw blobs on disk are unrecoverable to their original names
// without it).
export async function backupMetadata() {
  const dir = metadataBackupDir();
  await fsp.mkdir(dir, { recursive: true });
  if (!fs.existsSync(config.metaFile)) return;
  const filename = `metadata-${timestampName()}.json`;
  await fsp.copyFile(config.metaFile, path.join(dir, filename));

  const files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  const excess = files.slice(0, Math.max(0, files.length - config.backupRetentionCount));
  await Promise.all(excess.map((f) => fsp.unlink(path.join(dir, f)).catch(() => {})));
}

// A rough estimate of what a full backup would weigh, so the UI can warn
// before someone kicks one off with little disk headroom.
export async function estimateFullBackupSize() {
  let total = 0;
  if (fs.existsSync(config.blobDir)) {
    const files = await fsp.readdir(config.blobDir);
    const stats = await Promise.all(
      files.map((f) => fsp.stat(path.join(config.blobDir, f)).catch(() => null))
    );
    total += stats.reduce((sum, s) => sum + (s ? s.size : 0), 0);
  }
  if (fs.existsSync(config.metaFile)) {
    total += (await fsp.stat(config.metaFile)).size;
  }
  return total;
}

// A full backup (metadata + every blob) is on-demand only, never
// scheduled: it duplicates the entire data directory, so an automatic
// daily copy would be a fast way to fill the volume. Only the most recent
// one is ever kept on disk - download it and store it elsewhere for real,
// long-term, off-server retention.
export async function createFullBackup() {
  await fsp.mkdir(config.backupDir, { recursive: true });
  const filename = `full-backup-${timestampName()}.zip`;
  const filePath = path.join(config.backupDir, filename);
  const tmpPath = `${filePath}.tmp`;

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(tmpPath);
    const archive = new ZipArchive({ zlib: { level: 6 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    if (fs.existsSync(config.metaFile)) archive.file(config.metaFile, { name: 'metadata.json' });
    if (fs.existsSync(config.blobDir)) archive.directory(config.blobDir, 'blobs');
    archive.finalize();
  });
  await fsp.rename(tmpPath, filePath);

  const existing = await listBackups();
  const olderFull = existing.filter((b) => b.type === 'full' && b.filename !== filename);
  await Promise.all(
    olderFull.map((b) => fsp.unlink(path.join(config.backupDir, b.filename)).catch(() => {}))
  );

  return filename;
}

export async function listBackups() {
  const dir = metadataBackupDir();
  await fsp.mkdir(dir, { recursive: true });
  await fsp.mkdir(config.backupDir, { recursive: true });

  const metaFiles = (await fsp.readdir(dir)).filter((f) => f.endsWith('.json'));
  const metaEntries = await Promise.all(
    metaFiles.map(async (name) => {
      const st = await fsp.stat(path.join(dir, name));
      return { filename: name, type: 'metadata', size: st.size, createdAt: st.mtimeMs };
    })
  );

  const fullFiles = (await fsp.readdir(config.backupDir)).filter((f) => f.endsWith('.zip'));
  const fullEntries = await Promise.all(
    fullFiles.map(async (name) => {
      const st = await fsp.stat(path.join(config.backupDir, name));
      return { filename: name, type: 'full', size: st.size, createdAt: st.mtimeMs };
    })
  );

  return [...metaEntries, ...fullEntries].sort((a, b) => b.createdAt - a.createdAt);
}

export function backupFilePath(entry) {
  return entry.type === 'metadata'
    ? path.join(metadataBackupDir(), entry.filename)
    : path.join(config.backupDir, entry.filename);
}

export function scheduleMetadataBackups() {
  if (!config.backupEnabled) return;
  const run = () => backupMetadata().catch((err) => console.error('[backup] metadata backup failed:', err));
  setTimeout(run, 60 * 1000); // first pass shortly after boot
  setInterval(run, config.backupIntervalMs);
}
