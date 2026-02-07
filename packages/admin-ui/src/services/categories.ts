import { api } from "./api";

export interface Category {
  id: string;
  tenantId: string;
  key: string;
  name: string;
  subcategory: string | null;
  file: string;
  sortOrder: number;
  createdAt: string;
}

export const categoriesApi = {
  list: (tenantId?: string) =>
    api.get<Category[]>(tenantId ? `/categories?tenantId=${tenantId}` : "/categories"),

  create: (data: { key: string; name: string; subcategory?: string; file: string; sortOrder?: number; tenantId?: string }) =>
    api.post<Category>("/categories", data),

  update: (
    id: string,
    data: Partial<{ key: string; name: string; subcategory: string | null; file: string; sortOrder: number }>,
  ) => api.put<Category>(`/categories/${id}`, data),

  delete: (id: string) => api.delete<void>(`/categories/${id}`),
};
