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

export interface FlaggedQuestion {
  id: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  file: string;
  sourcePdf: string | null;
  success: boolean;
  data: {
    question_number: string;
    points: number;
    question_text: string;
    question_type: string;
    correct_answer: string;
    options: string[];
  } | null;
  categorization: {
    success: boolean;
    category?: string;
    subcategory?: string;
    reasoning?: string;
  } | null;
  similarityGroupId: string | null;
  pipelineRunId: string | null;
  markedWrong: boolean;
  markedWrongAt: string | null;
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

export interface FlaggedResponse {
  questions: FlaggedQuestion[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export const questionsApi = {
  list: (params?: { pipelineRunId?: string; category?: string; subcategory?: string; page?: number; limit?: number }) => {
    const searchParams = new URLSearchParams();
    if (params?.pipelineRunId) searchParams.set("pipelineRunId", params.pipelineRunId);
    if (params?.category) searchParams.set("category", params.category);
    if (params?.subcategory) searchParams.set("subcategory", params.subcategory);
    if (params?.page) searchParams.set("page", String(params.page));
    if (params?.limit) searchParams.set("limit", String(params.limit));
    const qs = searchParams.toString();
    return api.get<QuestionsResponse>(`/questions${qs ? `?${qs}` : ""}`);
  },

  listFlagged: (params?: { tenantId?: string; page?: number; limit?: number }) => {
    const searchParams = new URLSearchParams();
    if (params?.tenantId) searchParams.set("tenantId", params.tenantId);
    if (params?.page) searchParams.set("page", String(params.page));
    if (params?.limit) searchParams.set("limit", String(params.limit));
    const qs = searchParams.toString();
    return api.get<FlaggedResponse>(`/questions/flagged${qs ? `?${qs}` : ""}`);
  },

  reparse: (id: string) =>
    api.post<{ id: string; file: string; data: unknown; success: boolean }>(`/questions/${id}/reparse`),

  recategorize: (id: string) =>
    api.post<{ id: string; file: string; categorization: unknown }>(`/questions/${id}/recategorize`),

  update: (id: string, body: {
    data?: {
      question_text?: string;
      correct_answer?: string;
      question_type?: string;
      points?: number;
      options?: string[];
      question_number?: string;
    };
    categorization?: {
      category?: string;
      subcategory?: string;
    };
  }) => api.patch<{ id: string; file: string; data: unknown; categorization: unknown; success: boolean }>(`/questions/${id}`, body),

  resolve: (id: string) =>
    api.post<{ id: string; file: string; markedWrong: boolean }>(`/questions/${id}/resolve`),
};
