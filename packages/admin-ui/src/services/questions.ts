import { api } from "./api";

export interface QuestionItem {
  id: string;
  file: string;
  sourcePdf: string | null;
  success: boolean;
  data: Record<string, unknown> | null;
  categorization: Record<string, unknown> | null;
  similarityGroupId: string | null;
  pipelineRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QuestionsResponse {
  questions: QuestionItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export const questionsApi = {
  list: (params?: { pipelineRunId?: string; category?: string; subcategory?: string; page?: number; limit?: number; tenantId?: string }) => {
    const searchParams = new URLSearchParams();
    if (params?.pipelineRunId) searchParams.set("pipelineRunId", params.pipelineRunId);
    if (params?.category) searchParams.set("category", params.category);
    if (params?.subcategory) searchParams.set("subcategory", params.subcategory);
    if (params?.page) searchParams.set("page", String(params.page));
    if (params?.limit) searchParams.set("limit", String(params.limit));
    if (params?.tenantId) searchParams.set("tenantId", params.tenantId);
    const qs = searchParams.toString();
    return api.get<QuestionsResponse>(`/questions${qs ? `?${qs}` : ""}`);
  },
};
