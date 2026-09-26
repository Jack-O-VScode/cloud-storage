export function xmlEscape(str) {
  return String(str).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c])
  );
}

// One <D:response> block describing a single node for a PROPFIND reply.
// Ignores whatever specific properties the client asked for and always
// returns this fixed set - matches how many minimal WebDAV servers behave,
// and covers what every mainstream client (Explorer, Finder, rclone,
// Cyberduck) actually reads.
export function nodePropResponse(node, href) {
  const isCollection = node.type === 'folder';
  const lastModified = new Date(node.updatedAt || node.createdAt || Date.now()).toUTCString();
  const extra = isCollection
    ? ''
    : `<D:getcontentlength>${node.size || 0}</D:getcontentlength><D:getcontenttype>${xmlEscape(
        node.mimeType || 'application/octet-stream'
      )}</D:getcontenttype>`;
  return `<D:response>
<D:href>${xmlEscape(href)}</D:href>
<D:propstat>
<D:prop>
<D:resourcetype>${isCollection ? '<D:collection/>' : ''}</D:resourcetype>
<D:displayname>${xmlEscape(node.name)}</D:displayname>
<D:getlastmodified>${lastModified}</D:getlastmodified>
${extra}
</D:prop>
<D:status>HTTP/1.1 200 OK</D:status>
</D:propstat>
</D:response>`;
}

export function multistatus(entries) {
  return `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
${entries.join('\n')}
</D:multistatus>`;
}

// A fabricated, non-exclusive lock response - enough to satisfy clients
// (Windows' WebDAV client in particular) that insist on LOCK before PUT or
// DELETE, without implementing real distributed locking, which isn't
// warranted for what's normally a single-person drive.
export function lockResponse(token, timeoutSeconds) {
  return `<?xml version="1.0" encoding="utf-8"?>
<D:prop xmlns:D="DAV:">
<D:lockdiscovery>
<D:activelock>
<D:locktype><D:write/></D:locktype>
<D:lockscope><D:exclusive/></D:lockscope>
<D:depth>0</D:depth>
<D:timeout>Second-${timeoutSeconds}</D:timeout>
<D:locktoken><D:href>${token}</D:href></D:locktoken>
</D:activelock>
</D:lockdiscovery>
</D:prop>`;
}
