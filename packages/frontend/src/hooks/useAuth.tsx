import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { auth as authApi, setTokens, clearTokens, getAccessToken } from '../lib/api';

interface User {
  id: string;
  email: string;
  username: string;
  role: string;
  subscription: string;
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, username: string, password: string) => Promise<void>;
  logout: () => void;
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = getAccessToken();
    if (token) {
      authApi.me()
        .then((data: any) => setUser(data.user))
        .catch(() => clearTokens())
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  const login = async (email: string, password: string) => {
    const data: any = await authApi.login({ email, password });
    setTokens(data.accessToken, data.refreshToken);
    setUser(data.user);
  };

  const register = async (email: string, username: string, password: string) => {
    const data: any = await authApi.register({ email, username, password });
    setTokens(data.accessToken, data.refreshToken);
    setUser(data.user);
  };

  const logout = () => {
    authApi.logout().catch(() => {});
    clearTokens();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout, isAuthenticated: !!user }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
