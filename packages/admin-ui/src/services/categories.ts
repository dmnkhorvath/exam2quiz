import { api } from "./api";

export interface Category {
  id: string;
  tenantId: string;
  key: string;
  name: string;
  file: string;
  sortOrder: number;
  createdAt: string;
}

export const categoriesApi = {
  list: () => api.get<Category[]>("/categories"),

  create: (data: { key: string; name: string; file: string; sortOrder?: number }) =>
    api.post<Category>("/categories", data),

  update: (
    id: string,
    data: Partial<{ key: string; name: string; file: string; sortOrder: number }>,
  ) => api.put<Category>(`/categories/${id}`, data),

  delete: (id: string) => api.delete<void>(`/categories/${id}`),
};
