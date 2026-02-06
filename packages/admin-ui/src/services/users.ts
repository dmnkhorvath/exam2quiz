import { api } from "./api";
import type { User } from "./auth";

export type { User };

export const usersApi = {
  list: () => api.get<User[]>("/users"),

  create: (data: {
    email: string;
    password: string;
    name?: string;
    role?: string;
    tenantId?: string;
  }) => api.post<User>("/users", data),

  update: (
    id: string,
    data: Partial<{
      name: string;
      role: string;
      isActive: boolean;
      tenantId: string;
    }>,
  ) => api.put<User>(`/users/${id}`, data),

  delete: (id: string) => api.delete<void>(`/users/${id}`),
};
