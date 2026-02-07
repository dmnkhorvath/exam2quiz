import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { pipelinesApi, type PipelineRun } from "../services/pipelines";
import { questionsApi } from "../services/questions";

export default function QuestionsPage() {
  const [selectedRunId, setSelectedRunId] = useState<string>("");
  const [page, setPage] = useState(1);

  const { data: pipelinesData, isLoading: pipelinesLoading } = useQuery({
    queryKey: ["pipelines", { status: "COMPLETED", limit: 50 }],
    queryFn: () => pipelinesApi.list({ status: "COMPLETED", limit: 50 }),
  });

  const {
    data: questionsData,
    isLoading: questionsLoading,
    error: questionsError,
  } = useQuery({
    queryKey: ["questions", selectedRunId, page],
    queryFn: () =>
      questionsApi.list({
        pipelineRunId: selectedRunId || undefined,
        page,
        limit: 100,
      }),
  });

  const pipelines: PipelineRun[] = pipelinesData?.data ?? [];
  const resp = questionsData;

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">Questions</h1>

      {/* Pipeline filter (optional) */}
      <div className="form-control w-full max-w-md">
        <label className="label">
          <span className="label-text">Filter by pipeline run (optional)</span>
        </label>
        <select
          className="select select-bordered"
          value={selectedRunId}
          onChange={(e) => {
            setSelectedRunId(e.target.value);
            setPage(1);
          }}
          disabled={pipelinesLoading}
        >
          <option value="">All questions (tenant-wide)</option>
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
      {resp && (
        <div className="space-y-4">
          <div className="flex items-center gap-4 text-sm text-base-content/60">
            <span>Total: {resp.total}</span>
            <span>Page: {resp.page}/{resp.totalPages}</span>
          </div>

          <div className="mockup-code max-h-[70vh] overflow-auto">
            <pre className="px-4">
              <code>{JSON.stringify(resp.questions, null, 2)}</code>
            </pre>
          </div>

          {/* Pagination */}
          {resp.totalPages > 1 && (
            <div className="join">
              <button
                className="join-item btn btn-sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </button>
              <button className="join-item btn btn-sm btn-disabled">
                Page {resp.page} of {resp.totalPages}
              </button>
              <button
                className="join-item btn btn-sm"
                disabled={page >= resp.totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}

      {/* Empty state */}
      {!questionsLoading && resp && resp.total === 0 && (
        <div className="text-base-content/50 text-sm">
          No questions found. Run a pipeline to extract questions.
        </div>
      )}
    </div>
  );
}
