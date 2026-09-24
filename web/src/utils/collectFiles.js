// Converts plain File objects (from an <input> picker) into the
// {file, relativePath} shape used everywhere uploads are handled.
// webkitRelativePath is populated automatically by the browser when the
// input has the webkitdirectory attribute; empty string otherwise.
export function filesToEntries(fileList) {
  return Array.from(fileList).map((file) => ({
    file,
    relativePath: file.webkitRelativePath || '',
  }));
}

function readDirectory(reader) {
  return new Promise((resolve, reject) => {
    const all = [];
    const readBatch = () => {
      // Chrome only returns entries in batches of ~100 and requires
      // calling readEntries again until it returns an empty array.
      reader.readEntries((batch) => {
        if (batch.length === 0) return resolve(all);
        all.push(...batch);
        readBatch();
      }, reject);
    };
    readBatch();
  });
}

async function walkEntry(entry, pathPrefix, out) {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    out.push({ file, relativePath: pathPrefix + file.name });
  } else if (entry.isDirectory) {
    const entries = await readDirectory(entry.createReader());
    for (const child of entries) {
      await walkEntry(child, `${pathPrefix}${entry.name}/`, out);
    }
  }
}

// Converts a drop event's DataTransfer into {file, relativePath} entries,
// recursing into dropped folders when the browser supports it (Chrome,
// Edge, Safari on macOS/iPadOS). Falls back to a flat file list - no folder
// structure - on browsers that don't support the entry API.
export async function collectFilesFromDataTransfer(dataTransfer) {
  const items = dataTransfer.items;
  const out = [];
  if (items && items.length && typeof items[0].webkitGetAsEntry === 'function') {
    const entries = Array.from(items)
      .map((item) => item.webkitGetAsEntry())
      .filter(Boolean);
    if (entries.length) {
      for (const entry of entries) {
        await walkEntry(entry, '', out);
      }
      return out;
    }
  }
  return filesToEntries(dataTransfer.files);
}
