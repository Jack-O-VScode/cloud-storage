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
// `quota`, when given (only meaningful on the drive root), is
// { used, available } in bytes - the standard way (RFC 4331) for a WebDAV
// server to tell a client its real usage/free space. Without it, clients
// like Windows Explorer just invent a generic placeholder number instead
// of leaving the drive's Properties dialog blank.
export function nodePropResponse(node, href, quota) {
  const isCollection = node.type === 'folder';
  const lastModified = new Date(node.updatedAt || node.createdAt || Date.now()).toUTCString();
  const extra = isCollection
    ? ''
    : `<D:getcontentlength>${node.size || 0}</D:getcontentlength><D:getcontenttype>${xmlEscape(
        node.mimeType || 'application/octet-stream'
      )}</D:getcontenttype>`;
  const quotaProps = quota
    ? `<D:quota-used-bytes>${quota.used}</D:quota-used-bytes><D:quota-available-bytes>${quota.available}</D:quota-available-bytes>`
    : '';
  return `<D:response>
<D:href>${xmlEscape(href)}</D:href>
<D:propstat>
<D:prop>
<D:resourcetype>${isCollection ? '<D:collection/>' : ''}</D:resourcetype>
<D:displayname>${xmlEscape(node.name)}</D:displayname>
<D:getlastmodified>${lastModified}</D:getlastmodified>
${extra}
${quotaProps}
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

// Answers a PROPPATCH by reporting every property the client tried to set
// or remove as successfully handled. Namespace declarations from the
// request are carried over onto the response root so each echoed
// property keeps its own namespace (Windows uses its own for timestamps).
export function proppatchResponse(href, requestXml) {
  const nsDecls = new Map();
  for (const m of requestXml.matchAll(/xmlns(?::([\w.-]+))?\s*=\s*"([^"]*)"/g)) {
    if (m[1] && m[1] !== 'D') nsDecls.set(m[1], m[2]);
  }
  const props = new Set();
  for (const block of requestXml.matchAll(/<(?:[\w.-]+:)?prop\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?prop>/g)) {
    for (const m of block[1].matchAll(/<([\w.-]+:)?([\w.-]+)[\s/>]/g)) {
      const prefix = m[1] ? m[1].slice(0, -1) : null;
      if (prefix && prefix !== 'D' && !nsDecls.has(prefix)) continue;
      props.add(prefix ? `${prefix}:${m[2]}` : `D:${m[2]}`);
    }
  }
  const nsAttrs = [...nsDecls].map(([p, uri]) => ` xmlns:${p}="${xmlEscape(uri)}"`).join('');
  const propXml = [...props].map((p) => `<${p}/>`).join('');
  return `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:"${nsAttrs}>
<D:response>
<D:href>${xmlEscape(href)}</D:href>
<D:propstat>
<D:prop>${propXml}</D:prop>
<D:status>HTTP/1.1 200 OK</D:status>
</D:propstat>
</D:response>
</D:multistatus>`;
}
