import React, { useEffect, useState } from 'react';
import Modal from './Modal.jsx';
import { api } from '../api.js';
import { formatBytes, formatDate } from '../utils/format.js';

export default function BackupsModal({ onClose }) {
  const [backups, setBackups] = useState([]);
  const [disk, setDisk] = useState(null);
  const [estimatedFullSize, setEstimatedFullSize] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);

  const load = () =>
    api.listBackups().then((d) => {
      setBackups(d.backups);
      setDisk(d.disk);
      setEstimatedFullSize(d.estimatedFullSize);
    });

  useEffect(() => {
    load()
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const runFullBackup = async () => {
    setStarting(true);
    setError('');
    try {
      await api.createFullBackup();
      setTimeout(load, 4000); // give it a moment to appear
    } catch (err) {
      setError(err.message);
    } finally {
      setStarting(false);
    }
  };

  const lowOnSpace = disk?.free && estimatedFullSize > disk.free * 0.8;

  return (
    <Modal title="Backups" onClose={onClose} width={520} footer={<button className="btn" onClick={onClose}>Close</button>}>
      {loading && <p className="muted">Loading…</p>}
      {!loading && (
        <>
          <p className="muted small">
            A small metadata-only backup (your folder structure and file names) runs automatically every day and
            the last 30 are kept. A full backup (everything, including all files) is on-demand only — it isn't
            scheduled, since duplicating your whole data set daily would quickly fill the disk. Only the most
            recent full backup is kept on the server; download it and store it elsewhere for real, long-term
            protection.
          </p>

          <div className="backup-estimate">
            <span className="muted small">
              A full backup right now would be about <strong>{formatBytes(estimatedFullSize)}</strong>
              {disk?.free != null && <> · {formatBytes(disk.free)} free on disk</>}
            </span>
            {lowOnSpace && (
              <p className="form-error small">
                That's more than 80% of your free disk space — creating a full backup right now risks filling the
                volume. Free up space first, or proceed carefully.
              </p>
            )}
          </div>

          <button className="btn btn-primary btn-block" onClick={runFullBackup} disabled={starting}>
            {starting ? 'Starting…' : 'Create full backup now'}
          </button>
          {error && <p className="form-error">{error}</p>}

          <hr className="divider" />

          <div className="backups-list">
            {backups.length === 0 && <p className="muted">No backups yet.</p>}
            {backups.map((b) => (
              <div key={b.filename} className="backups-row">
                <div>
                  <strong>{b.type === 'full' ? 'Full backup' : 'Metadata backup'}</strong>
                  <div className="muted small">
                    {formatBytes(b.size)} · {formatDate(b.createdAt)}
                  </div>
                </div>
                <a className="btn" href={api.backupDownloadUrl(b.filename)}>
                  Download
                </a>
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}
