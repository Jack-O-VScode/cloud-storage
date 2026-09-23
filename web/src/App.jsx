import React from 'react';
import { useAuth } from './context/AuthContext.jsx';
import { ToastProvider } from './components/Toasts.jsx';
import SetupPage from './pages/SetupPage.jsx';
import LoginPage from './pages/LoginPage.jsx';
import DrivePage from './pages/DrivePage.jsx';
import SharePage from './pages/SharePage.jsx';

export default function App() {
  const shareMatch = /^\/s\/([^/]+)/.exec(window.location.pathname);
  if (shareMatch) {
    return <SharePage token={shareMatch[1]} />;
  }
  return (
    <ToastProvider>
      <Gate />
    </ToastProvider>
  );
}

function Gate() {
  const { status, setupNeeded, user } = useAuth();

  if (status === 'loading') {
    return <div className="empty-state full-screen">Loading…</div>;
  }
  if (setupNeeded) return <SetupPage />;
  if (!user) return <LoginPage />;
  return <DrivePage />;
}
