import { api } from "./api";

export interface BatchChildRun {
  id: string;
  status: string;
  currentStage: string | null;
  batchIndex: number | null;
  error: string | null;
  filenames: string[];
}

export interface PipelineRun {
  id: string;
  tenantId: string;
  filenames: string[];
  sourceUrls: string[];
  status: "QUEUED" | "PROCESSING" | "PAUSED" | "COMPLETED" | "FAILED" | "CANCELLED";
  currentStage: string | null;
  progress: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  totalBatches?: number | null;
  parentRunId?: string | null;
  jobs?: PipelineJob[];
  childRuns?: BatchChildRun[];
}

export interface PipelineJob {
  id: string;
  stage: string;
  status: string;
  progress: number;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface PipelineListResponse {
  data: PipelineRun[];
  total: number;
  limit: number;
  offset: number;
}

export const pipelinesApi = {
  list: (params?: { status?: string; limit?: number; offset?: number; tenantId?: string }) => {
    const query = new URLSearchParams();
    if (params?.status) query.set("status", params.status);
    if (params?.limit) query.set("limit", String(params.limit));
    if (params?.offset) query.set("offset", String(params.offset));
    if (params?.tenantId) query.set("tenantId", params.tenantId);
    const qs = query.toString();
    return api.get<PipelineListResponse>(`/pipelines${qs ? `?${qs}` : ""}`);
  },

  get: (id: string) => api.get<PipelineRun>(`/pipelines/${id}`),

  upload: (files: File[], urls: string, tenantId?: string) => {
    const form = new FormData();
    for (const f of files) form.append("files", f);
    if (urls.trim()) form.append("urls", urls.trim());
    if (tenantId) form.append("tenantId", tenantId);
    return api.post<PipelineRun>("/pipelines", form);
  },

  cancel: (id: string) => api.delete<void>(`/pipelines/${id}`),

  restart: (id: string) => api.post<PipelineRun>(`/pipelines/${id}/restart`),

  deletePipeline: (id: string) =>
    api.delete<void>(`/pipelines/${id}/delete`),

  merge: (pipelineRunIds: string[]) =>
    api.post<PipelineRun>("/pipelines/merge", { pipelineRunIds }),

  listSplits: (id: string) =>
    api.get<{ files: string[] }>(`/pipelines/${id}/splits`),

  getSplit: (id: string, filename: string) =>
    api.get<{ category_name: string; subcategory_name?: string; groups: unknown[][] }>(`/pipelines/${id}/splits/${filename}`),

  downloadCategorized: (id: string) => {
    // Return the URL for direct download via anchor element
    return `/api/pipelines/${id}/categorized`;
  },

  submitSimilarityUrl: (id: string, url: string) =>
    api.post<void>(`/pipelines/${id}/similarity-url`, { url }),
};
