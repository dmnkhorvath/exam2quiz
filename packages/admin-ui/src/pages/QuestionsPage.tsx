import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { pipelinesApi, type PipelineRun } from "../services/pipelines";

export default function QuestionsPage() {
  const [selectedRunId, setSelectedRunId] = useState<string>("");
  const [selectedFile, setSelectedFile] = useState<string>("");

  const { data: pipelinesData, isLoading: pipelinesLoading } = useQuery({
    queryKey: ["pipelines", { status: "COMPLETED", limit: 50 }],
    queryFn: () => pipelinesApi.list({ status: "COMPLETED", limit: 50 }),
  });

  const { data: splitsData, isLoading: splitsLoading } = useQuery({
    queryKey: ["splits", selectedRunId],
    queryFn: () => pipelinesApi.listSplits(selectedRunId),
    enabled: !!selectedRunId,
  });

  const {
    data: splitContent,
    isLoading: contentLoading,
    error: contentError,
  } = useQuery({
    queryKey: ["split", selectedRunId, selectedFile],
    queryFn: () => pipelinesApi.getSplit(selectedRunId, selectedFile),
    enabled: !!selectedRunId && !!selectedFile,
  });

  const pipelines: PipelineRun[] = pipelinesData?.data ?? [];
  const files = splitsData?.files ?? [];

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">Questions</h1>

      {/* Pipeline filter */}
      <div className="form-control w-full max-w-md">
        <label className="label">
          <span className="label-text">Select pipeline run</span>
        </label>
        <select
          className="select select-bordered"
          value={selectedRunId}
          onChange={(e) => {
            setSelectedRunId(e.target.value);
            setSelectedFile("");
          }}
          disabled={pipelinesLoading}
        >
          <option value="">Select a completed pipeline run...</option>
          {pipelines.map((p) => (
            <option key={p.id} value={p.id}>
              {(p.filenames ?? []).join(", ") || p.id} — {new Date(p.createdAt).toLocaleDateString()}
            </option>
          ))}
        </select>
      </div>

      {/* Category tabs */}
      {selectedRunId && !splitsLoading && files.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {files.map((file) => (
            <button
              key={file}
              className={`btn btn-sm ${selectedFile === file ? "btn-primary" : "btn-outline"}`}
              onClick={() => setSelectedFile(file)}
            >
              {file.replace(/\.json$/, "")}
            </button>
          ))}
        </div>
      )}

      {/* Loading states */}
      {(splitsLoading || contentLoading) && (
        <div className="flex items-center gap-2">
          <span className="loading loading-spinner loading-sm" />
          <span>{splitsLoading ? "Loading categories..." : "Loading questions..."}</span>
        </div>
      )}

      {/* Error state */}
      {contentError && (
        <div className="alert alert-error">
          <span>
            {contentError instanceof Error ? contentError.message : "Failed to load split file"}
          </span>
        </div>
      )}

      {/* Split content */}
      {splitContent && (
        <div className="space-y-4">
          <div className="flex items-center gap-4 text-sm text-base-content/60">
            <span>Category: {splitContent.category_name}</span>
            <span>Groups: {splitContent.groups.length}</span>
            <span>
              Questions: {splitContent.groups.reduce((sum, g) => sum + g.length, 0)}
            </span>
          </div>

          <div className="mockup-code max-h-[70vh] overflow-auto">
            <pre className="px-4">
              <code>{JSON.stringify(splitContent, null, 2)}</code>
            </pre>
          </div>
        </div>
      )}

      {/* Empty states */}
      {!selectedRunId && (
        <div className="text-base-content/50 text-sm">
          Select a pipeline run to view category split results.
        </div>
      )}

      {selectedRunId && !splitsLoading && files.length === 0 && (
        <div className="text-base-content/50 text-sm">
          No category split files found for this pipeline run.
        </div>
      )}
    </div>
  );
}
