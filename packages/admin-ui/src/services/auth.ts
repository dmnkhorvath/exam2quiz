import { api } from "./api";

export interface User {
  id: string;
  email: string;
  name: string | null;
  role: "SUPER_ADMIN" | "TENANT_ADMIN" | "TENANT_USER";
  tenantId: string | null;
  isActive: boolean;
  createdAt: string;
}

interface LoginResponse {
  token: string;
  user: User;
}

export const authApi = {
  login: (email: string, password: string) =>
    api.post<LoginResponse>("/auth/login", { email, password }),

  register: (data: {
    email: string;
    password: string;
    name?: string;
    role?: string;
    tenantId?: string;
  }) => api.post<User>("/auth/register", data),

  me: () => api.get<User>("/auth/me"),
};
