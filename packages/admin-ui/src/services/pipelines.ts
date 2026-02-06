import { api } from "./api";

export interface PipelineRun {
  id: string;
  tenantId: string;
  filename: string;
  status: "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED" | "CANCELLED";
  currentStage: string | null;
  progress: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  jobs?: PipelineJob[];
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
  list: (params?: { status?: string; limit?: number; offset?: number }) => {
    const query = new URLSearchParams();
    if (params?.status) query.set("status", params.status);
    if (params?.limit) query.set("limit", String(params.limit));
    if (params?.offset) query.set("offset", String(params.offset));
    const qs = query.toString();
    return api.get<PipelineListResponse>(`/pipelines${qs ? `?${qs}` : ""}`);
  },

  get: (id: string) => api.get<PipelineRun>(`/pipelines/${id}`),

  upload: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return api.post<PipelineRun>("/pipelines", form);
  },

  cancel: (id: string) => api.delete<void>(`/pipelines/${id}`),
};
