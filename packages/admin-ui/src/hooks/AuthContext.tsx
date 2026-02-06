import {
  createContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { authApi, type User } from "../services/auth";
import { setToken, getToken } from "../services/api";

export interface AuthCtx {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  isSuperAdmin: boolean;
  isAdmin: boolean;
}

export const AuthContext = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(!!getToken());
  const qc = useQueryClient();

  useEffect(() => {
    if (!getToken()) return;
    authApi
      .me()
      .then(setUser)
      .catch(() => {
        setToken(null);
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await authApi.login(email, password);
    setToken(res.token);
    setUser(res.user);
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    qc.clear();
  }, [qc]);

  const isSuperAdmin = user?.role === "SUPER_ADMIN";
  const isAdmin = isSuperAdmin || user?.role === "TENANT_ADMIN";

  return (
    <AuthContext.Provider
      value={{ user, loading, login, logout, isSuperAdmin, isAdmin }}
    >
      {children}
    </AuthContext.Provider>
  );
}
