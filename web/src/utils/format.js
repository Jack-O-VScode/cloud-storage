export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export function formatSpeed(bytesPerSecond) {
  if (!bytesPerSecond || bytesPerSecond <= 0) return '';
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

export function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric',
  });
}

export function mimeCategory(node) {
  if (node.type === 'folder') return 'folder';
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
