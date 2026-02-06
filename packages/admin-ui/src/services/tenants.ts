import { api } from "./api";

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  geminiApiKey: string | null;
  maxConcurrentPipelines: number;
  storageQuotaMb: number;
  isActive: boolean;
  createdAt: string;
  _count?: { users: number; pipelineRuns: number };
}

export const tenantsApi = {
  list: () => api.get<Tenant[]>("/tenants"),

  get: (id: string) => api.get<Tenant>(`/tenants/${id}`),

  create: (data: {
    name: string;
    slug: string;
    geminiApiKey?: string;
    maxConcurrentPipelines?: number;
    storageQuotaMb?: number;
  }) => api.post<Tenant>("/tenants", data),

  update: (
    id: string,
    data: Partial<{
      name: string;
      slug: string;
      geminiApiKey: string;
      maxConcurrentPipelines: number;
      storageQuotaMb: number;
      isActive: boolean;
    }>,
  ) => api.put<Tenant>(`/tenants/${id}`, data),

  delete: (id: string) => api.delete<void>(`/tenants/${id}`),
};
