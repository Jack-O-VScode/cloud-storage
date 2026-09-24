import { ZipArchive } from 'archiver';
import { getState } from '../store.js';
import { blobPath } from './paths.js';

function addNode(archive, node, entryPrefix) {
  const entryPath = entryPrefix + node.name;
  if (node.type === 'file') {
    archive.file(blobPath(node.blobName), { name: entryPath });
  } else {
    const children = getState().nodes.filter(
      (n) => n.parentId === node.id && n.ownerId === node.ownerId && !n.trashed
    );
    for (const child of children) addNode(archive, child, `${entryPath}/`);
  }
}

// Streams a zip of `nodes` (files added directly, folders recursed into
// preserving their structure) straight to the response.
export function streamZip(res, nodes, zipName) {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`);
  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.on('error', (err) => {
    console.error(err);
    res.destroy(err);
  });
  archive.pipe(res);
  for (const node of nodes) addNode(archive, node, '');
  return archive.finalize();
}
