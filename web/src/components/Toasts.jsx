import React, { createContext, useCallback, useContext, useState } from 'react';

const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  // `action`, when given, is { label, onClick } - rendered as a button
  // inside the toast (e.g. "Undo") that doesn't dismiss it on its own.
  const push = useCallback((message, kind = 'info', timeout = 4000, action) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, message, kind, action }]);
    if (timeout) setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), timeout);
    return id;
  }, []);

  const dismiss = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  return (
    <ToastContext.Provider value={{ push, dismiss }}>
      {children}
      <div className="toast-stack">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            <span onClick={() => dismiss(t.id)}>{t.message}</span>
            {t.action && (
              <button
                className="link-btn toast-action"
                onClick={() => {
                  t.action.onClick();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
