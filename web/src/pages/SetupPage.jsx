import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';

export default function SetupPage() {
  const { completeSetup } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    setBusy(true);
    try {
      await completeSetup(username, password);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <h1>Welcome</h1>
        <p className="muted">Create the admin account for your cloud storage.</p>
        <label className="field-label">Username</label>
        <input className="text-input" value={username} onChange={(e) => setUsername(e.target.value)} required />
        <label className="field-label">Password</label>
        <input
          className="text-input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={8}
          required
        />
        <label className="field-label">Confirm password</label>
        <input
          className="text-input"
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          minLength={8}
          required
        />
        {error && <p className="form-error">{error}</p>}
        <button className="btn btn-primary btn-block" disabled={busy}>
          Create account
        </button>
      </form>
    </div>
  );
}
