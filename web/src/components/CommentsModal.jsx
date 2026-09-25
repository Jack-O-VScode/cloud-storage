import React, { useCallback, useEffect, useState } from 'react';
import Modal from './Modal.jsx';
import { api } from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { formatDate } from '../utils/format.js';

export default function CommentsModal({ node, onChanged, onClose }) {
  const { user } = useAuth();
  const [comments, setComments] = useState(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api
      .listComments(node.id)
      .then((data) => setComments(data.comments))
      .catch((e) => setError(e.message));
  }, [node.id]);

  useEffect(() => {
    load();
  }, [load]);

  const submit = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setError('');
    try {
      const data = await api.addComment(node.id, text.trim());
      setComments(data.comments);
      setText('');
      onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (commentId) => {
    try {
      const data = await api.deleteComment(node.id, commentId);
      setComments(data.comments);
      onChanged?.();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <Modal
      title={`Comments — ${node.name}`}
      onClose={onClose}
      footer={
        <button className="btn" onClick={onClose}>
          Close
        </button>
      }
    >
      {comments === null && <p className="muted">Loading…</p>}
      {comments?.length === 0 && <p className="muted small">No comments yet.</p>}
      <div className="comments-list">
        {comments?.map((c) => (
          <div key={c.id} className="comment-row">
            <div className="comment-row-header">
              <strong>{c.username}</strong>
              <span className="muted small">{formatDate(c.createdAt)}</span>
              {c.userId === user?.id && (
                <button className="link-btn danger comment-delete" onClick={() => remove(c.id)}>
                  Delete
                </button>
              )}
            </div>
            <p className="comment-text">{c.text}</p>
          </div>
        ))}
      </div>

      {error && <p className="form-error">{error}</p>}

      <form onSubmit={submit} className="comment-form">
        <textarea
          className="text-input comment-input"
          placeholder="Add a comment…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
        />
        <button className="btn btn-primary" type="submit" disabled={busy || !text.trim()}>
          Add comment
        </button>
      </form>
    </Modal>
  );
}
