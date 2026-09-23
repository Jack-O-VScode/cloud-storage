import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { formatBytes } from '../utils/format.js';

export default function SharePage({ token }) {
  const [item, setItem] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(`/api/share/${token}`)
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Not found');
        setItem(data.item);
      })
      .catch((e) => setError(e.message));
  }, [token]);

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1>Shared file</h1>
        {error && <p className="form-error">{error}</p>}
        {item && (
          <>
            <p>
              <strong>{item.name}</strong>
            </p>
            <p className="muted">{formatBytes(item.size)}</p>
            <a className="btn btn-primary btn-block" href={api.shareDownloadUrl(token)}>
              Download
            </a>
          </>
        )}
      </div>
    </div>
  );
}
