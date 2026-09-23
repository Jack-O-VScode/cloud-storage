import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from '../api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [setupNeeded, setSetupNeeded] = useState(false);
  const [status, setStatus] = useState('loading'); // loading | ready

  const bootstrap = useCallback(async () => {
    setStatus('loading');
    try {
      const { setupNeeded } = await api.setupNeeded();
      if (setupNeeded) {
        setSetupNeeded(true);
        setUser(null);
      } else {
        setSetupNeeded(false);
        try {
          const { user } = await api.me();
          setUser(user);
        } catch {
          setUser(null);
        }
      }
    } finally {
      setStatus('ready');
    }
  }, []);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  const login = async (username, password) => {
    const { user } = await api.login(username, password);
    setUser(user);
  };

  const completeSetup = async (username, password) => {
    const { user } = await api.setup(username, password);
    setSetupNeeded(false);
    setUser(user);
  };

  const logout = async () => {
    await api.logout();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, setupNeeded, status, login, logout, completeSetup }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
