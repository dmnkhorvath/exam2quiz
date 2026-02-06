import { api } from "./api";

export interface QuestionsResponse {
  pipelineRunId: string;
  source: string;
  count: number;
  questions: unknown[];
}

export const questionsApi = {
  list: (pipelineRunId: string) =>
    api.get<QuestionsResponse>(`/questions?pipelineRunId=${pipelineRunId}`),
};
