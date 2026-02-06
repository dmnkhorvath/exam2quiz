import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { pipelinesApi } from "../services/pipelines";
import { questionsApi } from "../services/questions";

export default function QuestionsPage() {
  const [selectedRunId, setSelectedRunId] = useState("");

  const { data: pipelinesData, isLoading: loadingPipelines } = useQuery({
    queryKey: ["pipelines", "COMPLETED"],
    queryFn: () => pipelinesApi.list({ status: "COMPLETED", limit: 100 }),
  });

  const {
    data: questionsData,
    isLoading: loadingQuestions,
    error: questionsError,
  } = useQuery({
    queryKey: ["questions", selectedRunId],
    queryFn: () => questionsApi.get(selectedRunId),
    enabled: !!selectedRunId,
  });

  const runs = pipelinesData?.data ?? [];

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-bold">Questions</h1>

      <div className="flex items-center gap-4">
        <select
          className="select select-bordered select-sm w-96"
          value={selectedRunId}
          onChange={(e) => setSelectedRunId(e.target.value)}
        >
          <option value="">Select a completed pipeline run...</option>
          {loadingPipelines && <option disabled>Loading...</option>}
          {runs.map((r) => (
            <option key={r.id} value={r.id}>
              {r.filename} ({new Date(r.createdAt).toLocaleDateString()})
            </option>
          ))}
        </select>

        {loadingQuestions && (
          <span className="loading loading-spinner loading-sm" />
        )}
      </div>

      {questionsError && (
        <div className="alert alert-error text-sm">
          {questionsError instanceof Error
            ? questionsError.message
            : "Failed to load questions"}
        </div>
      )}

      {questionsData && (
        <div className="space-y-2">
          <div className="flex gap-4 text-sm text-base-content/60">
            <span>
              Source: <span className="font-mono">{questionsData.source}</span>
            </span>
            <span>
              Count: <span className="font-mono">{questionsData.count}</span>
            </span>
          </div>

          <pre className="bg-base-100 rounded-lg shadow p-4 overflow-auto max-h-[calc(100vh-16rem)] text-xs">
            <code>{JSON.stringify(questionsData.questions, null, 2)}</code>
          </pre>
        </div>
      )}

      {selectedRunId && !loadingQuestions && !questionsData && !questionsError && (
        <div className="text-base-content/60 text-sm py-8 text-center">
          No question data available for this pipeline run
        </div>
      )}

      {!selectedRunId && (
        <div className="text-base-content/60 text-sm py-8 text-center">
          Select a completed pipeline run to view its questions
        </div>
      )}
    </div>
  );
}
