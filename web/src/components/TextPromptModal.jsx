import React, { useState } from 'react';
import Modal from './Modal.jsx';

export default function TextPromptModal({
  title,
  label,
  initialValue = '',
  confirmLabel = 'Save',
  onSubmit,
  onCancel,
}) {
  const [value, setValue] = useState(initialValue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (!value.trim()) return;
    setBusy(true);
    setError('');
    try {
      await onSubmit(value.trim());
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel} type="button">
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <form onSubmit={submit}>
        <label className="field-label">{label}</label>
        {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
        <input
          autoFocus
          className="text-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={(e) => e.target.select()}
        />
        {error && <p className="form-error">{error}</p>}
      </form>
    </Modal>
  );
}
