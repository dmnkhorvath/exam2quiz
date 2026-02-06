import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { pipelinesApi, type PipelineRun } from "../services/pipelines";
import { questionsApi } from "../services/questions";

export default function QuestionsPage() {
  const [selectedRunId, setSelectedRunId] = useState<string>("");

  const { data: pipelinesData, isLoading: pipelinesLoading } = useQuery({
    queryKey: ["pipelines", { status: "COMPLETED", limit: 50 }],
    queryFn: () => pipelinesApi.list({ status: "COMPLETED", limit: 50 }),
  });

  const {
    data: questionsData,
    isLoading: questionsLoading,
    error: questionsError,
  } = useQuery({
    queryKey: ["questions", selectedRunId],
    queryFn: () => questionsApi.list(selectedRunId),
    enabled: !!selectedRunId,
  });

  const pipelines: PipelineRun[] = pipelinesData?.data ?? [];

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">Questions</h1>

      {/* Pipeline selector */}
      <div className="form-control w-full max-w-md">
        <label className="label">
          <span className="label-text">Select a completed pipeline run</span>
        </label>
        <select
          className="select select-bordered"
          value={selectedRunId}
          onChange={(e) => setSelectedRunId(e.target.value)}
          disabled={pipelinesLoading}
        >
          <option value="">
            {pipelinesLoading ? "Loading..." : "-- Choose pipeline --"}
          </option>
          {pipelines.map((p) => (
            <option key={p.id} value={p.id}>
              {(p.filenames ?? []).join(", ") || p.id} — {new Date(p.createdAt).toLocaleDateString()}
            </option>
          ))}
        </select>
      </div>

      {/* Loading state */}
      {questionsLoading && (
        <div className="flex items-center gap-2">
          <span className="loading loading-spinner loading-sm" />
          <span>Loading questions...</span>
        </div>
      )}

      {/* Error state */}
      {questionsError && (
        <div className="alert alert-error">
          <span>
            {questionsError instanceof Error
              ? questionsError.message
              : "Failed to load questions"}
          </span>
        </div>
      )}

      {/* Questions data */}
      {questionsData && (
        <div className="space-y-4">
          <div className="flex items-center gap-4 text-sm text-base-content/60">
            <span>Source: {questionsData.source}</span>
            <span>Count: {questionsData.count}</span>
          </div>

          <div className="mockup-code max-h-[70vh] overflow-auto">
            <pre className="px-4">
              <code>{JSON.stringify(questionsData.questions, null, 2)}</code>
            </pre>
          </div>
        </div>
      )}

      {/* No data state (selected but nothing returned) */}
      {selectedRunId && !questionsLoading && !questionsData && !questionsError && (
        <div className="text-base-content/50 text-sm">
          No question data available for this pipeline run.
        </div>
      )}

      {/* Empty state */}
      {!selectedRunId && !questionsLoading && (
        <div className="text-base-content/50 text-sm">
          Select a pipeline run to view its extracted questions.
        </div>
      )}
    </div>
  );
}
