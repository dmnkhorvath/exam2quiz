import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { pipelinesApi, type BatchChildRun } from "../services/pipelines";

export default function PipelinesPage() {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState("");
  const [detail, setDetail] = useState<string | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [urls, setUrls] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const { data, isLoading } = useQuery({
    queryKey: ["pipelines", filter],
    queryFn: () =>
      pipelinesApi.list({
        status: filter || undefined,
        limit: 50,
      }),
    refetchInterval: 5000,
  });

  const canSubmit = selectedFiles.length > 0 || urls.trim().length > 0;

  const uploadMut = useMutation({
    mutationFn: ({ files, urls: u }: { files: File[]; urls: string }) =>
      pipelinesApi.upload(files, u),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pipelines"] });
      setSelectedFiles([]);
      setUrls("");
      if (fileRef.current) fileRef.current.value = "";
    },
  });

  const cancelMut = useMutation({
    mutationFn: (id: string) => pipelinesApi.cancel(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pipelines"] }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => pipelinesApi.deletePipeline(id),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ["pipelines"] });
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    },
  });

  const mergeMut = useMutation({
    mutationFn: (ids: string[]) => pipelinesApi.merge(ids),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pipelines"] });
      setSelectedIds(new Set());
    },
  });

  const runs = data?.data ?? [];

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-bold">Pipelines</h1>

      <div className="bg-base-100 rounded-lg shadow p-4 space-y-3">
        <div className="flex gap-4 items-start">
          <div className="flex-1 space-y-1">
            <label className="label label-text text-xs">PDF Files</label>
            <input
              ref={fileRef}
              type="file"
              accept=".pdf"
              multiple
              className="file-input file-input-bordered file-input-sm w-full"
              onChange={(e) =>
                setSelectedFiles(e.target.files ? Array.from(e.target.files) : [])
              }
            />
            {selectedFiles.length > 0 && (
              <p className="text-xs text-base-content/60">
                {selectedFiles.length} file{selectedFiles.length > 1 ? "s" : ""} selected
              </p>
            )}
          </div>
          <div className="flex-1 space-y-1">
            <label className="label label-text text-xs">URLs (one per line)</label>
            <textarea
              className="textarea textarea-bordered textarea-sm w-full"
              rows={2}
              placeholder="https://example.com/exam1.pdf&#10;https://example.com/exam2.pdf"
              value={urls}
              onChange={(e) => setUrls(e.target.value)}
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="btn btn-primary btn-sm"
            disabled={!canSubmit || uploadMut.isPending}
            onClick={() => uploadMut.mutate({ files: selectedFiles, urls })}
          >
            Start Pipeline
          </button>
          {uploadMut.isPending && (
            <span className="loading loading-spinner loading-sm" />
          )}
        </div>
      </div>

      {uploadMut.isError && (
        <div className="alert alert-error text-sm">
          {uploadMut.error.message}
        </div>
      )}

      {deleteMut.isError && (
        <div className="alert alert-error text-sm">
          Delete failed: {deleteMut.error.message}
        </div>
      )}

      {mergeMut.isError && (
        <div className="alert alert-error text-sm">
          Merge failed: {mergeMut.error.message}
        </div>
      )}

      {selectedIds.size >= 2 && (
        <div className="flex items-center gap-2">
          <button
            className="btn btn-secondary btn-sm"
            disabled={mergeMut.isPending}
            onClick={() => mergeMut.mutate([...selectedIds])}
          >
            Merge Selected ({selectedIds.size})
          </button>
          {mergeMut.isPending && (
            <span className="loading loading-spinner loading-sm" />
          )}
          <button
            className="btn btn-ghost btn-xs"
            onClick={() => setSelectedIds(new Set())}
          >
            Clear selection
          </button>
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-2">
        {["", "QUEUED", "PROCESSING", "COMPLETED", "FAILED", "CANCELLED"].map(
          (s) => (
            <button
              key={s}
              className={`btn btn-xs ${filter === s ? "btn-primary" : "btn-ghost"}`}
              onClick={() => setFilter(s)}
            >
              {s || "All"}
            </button>
          ),
        )}
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <span className="loading loading-spinner" />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="table table-sm bg-base-100 rounded-lg shadow">
            <thead>
              <tr>
                <th className="w-8"></th>
                <th>File</th>
                <th>Status</th>
                <th>Stage</th>
                <th>Progress</th>
                <th>Error</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((p) => {
                const isBatch = (p.totalBatches ?? 0) > 0;
                const children = p.childRuns ?? [];
                const completedBatches = children.filter((c) => c.status === "COMPLETED").length;
                const failedBatches = children.filter((c) => c.status === "FAILED").length;
                return (
                <tr key={p.id} className={selectedIds.has(p.id) ? "bg-base-200" : ""}>
                  <td>
                    {p.status === "COMPLETED" && (
                      <input
                        type="checkbox"
                        className="checkbox checkbox-xs"
                        checked={selectedIds.has(p.id)}
                        onChange={() => toggleSelect(p.id)}
                      />
                    )}
                  </td>
                  <td className="font-mono text-xs max-w-48 truncate">
                    {isBatch && (
                      <span className="badge badge-xs badge-outline mr-1">
                        batch
                      </span>
                    )}
                    {(p.filenames ?? []).join(", ") || "-"}
                  </td>
                  <td>
                    <StatusBadge status={p.status} />
                  </td>
                  <td className="text-xs">
                    {p.currentStage ?? "-"}
                    {isBatch && (
                      <div className="text-xs text-base-content/60 mt-0.5">
                        {completedBatches}/{p.totalBatches} batches
                        {failedBatches > 0 && (
                          <span className="text-error ml-1">({failedBatches} failed)</span>
                        )}
                      </div>
                    )}
                  </td>
                  <td>
                    {p.status !== "FAILED" && p.status !== "CANCELLED" && p.status !== "COMPLETED" ? (
                      isBatch ? (
                        <progress
                          className="progress progress-primary w-20"
                          value={completedBatches}
                          max={p.totalBatches ?? 1}
                        />
                      ) : (
                        <progress
                          className="progress progress-primary w-20"
                          value={p.progress}
                          max={100}
                        />
                      )
                    ) : (
                      <span className="text-xs text-base-content/40">-</span>
                    )}
                  </td>
                  <td className="text-xs text-error max-w-48 truncate" title={p.error ?? undefined}>
                    {p.error ?? "-"}
                  </td>
                  <td className="text-xs">
                    {new Date(p.createdAt).toLocaleString()}
                  </td>
                  <td className="space-x-1">
                    <button
                      className="btn btn-ghost btn-xs"
                      onClick={() => setDetail(p.id)}
                    >
                      Detail
                    </button>
                    {(p.status === "QUEUED" || p.status === "PROCESSING") && (
                      <button
                        className="btn btn-ghost btn-xs text-error"
                        onClick={() => cancelMut.mutate(p.id)}
                      >
                        Cancel
                      </button>
                    )}
                    {(p.status === "COMPLETED" || p.status === "FAILED" || p.status === "CANCELLED") && (
                      <button
                        className="btn btn-ghost btn-xs text-error"
                        disabled={deleteMut.isPending}
                        onClick={() => {
                          if (window.confirm(`Delete pipeline "${(p.filenames ?? []).join(", ") || p.id}"? This cannot be undone.`)) {
                            deleteMut.mutate(p.id);
                          }
                        }}
                      >
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
                );
              })}
              {runs.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-center text-base-content/60 py-8">
                    No pipeline runs
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {data && (
        <div className="text-xs text-base-content/60">
          Showing {runs.length} of {data.total} results
        </div>
      )}

      {detail && (
        <PipelineDetail id={detail} onClose={() => setDetail(null)} />
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls: Record<string, string> = {
    QUEUED: "badge-ghost",
    PROCESSING: "badge-info",
    COMPLETED: "badge-success",
    FAILED: "badge-error",
    CANCELLED: "badge-warning",
  };
  return (
    <span className={`badge badge-sm ${cls[status] ?? "badge-ghost"}`}>
      {status}
    </span>
  );
}

function PipelineDetail({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["pipeline", id],
    queryFn: () => pipelinesApi.get(id),
    refetchInterval: 3000,
  });

  return (
    <div className="modal modal-open">
      <div className="modal-box max-w-2xl">
        <h3 className="font-bold text-lg">Pipeline Detail</h3>

        {isLoading ? (
          <div className="flex justify-center py-8">
            <span className="loading loading-spinner" />
          </div>
        ) : data ? (
          <div className="mt-4 space-y-4">
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div>
                <span className="text-base-content/60">Files:</span>{" "}
                <span className="font-mono">{(data.filenames ?? []).join(", ") || "-"}</span>
              </div>
              <div>
                <span className="text-base-content/60">Status:</span>{" "}
                <StatusBadge status={data.status} />
              </div>
              <div>
                <span className="text-base-content/60">Stage:</span>{" "}
                {data.currentStage ?? "-"}
              </div>
              <div>
                <span className="text-base-content/60">Created:</span>{" "}
                {new Date(data.createdAt).toLocaleString()}
              </div>
            </div>

            {data.error && (
              <div className="alert alert-error text-sm">{data.error}</div>
            )}

            {(data.childRuns?.length ?? 0) > 0 && (
              <BatchChildList childRuns={data.childRuns!} totalBatches={data.totalBatches ?? 0} />
            )}

            {data.jobs && data.jobs.length > 0 && (
              <div>
                <h4 className="font-semibold mb-2">Jobs</h4>
                <div className="space-y-2">
                  {data.jobs.map((j) => (
                    <div
                      key={j.id}
                      className="flex items-center gap-3 text-sm bg-base-200 rounded px-3 py-2"
                    >
                      <span className="font-mono text-xs w-32">
                        {j.stage}
                      </span>
                      <StatusBadge status={j.status} />
                      <progress
                        className="progress progress-sm w-24"
                        value={j.progress}
                        max={100}
                      />
                      {j.error && (
                        <span className="text-error text-xs break-all" title={j.error}>
                          {j.error}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : null}

        <div className="modal-action">
          <button className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      <div className="modal-backdrop" onClick={onClose} />
    </div>
  );
}

function BatchChildList({
  childRuns,
  totalBatches,
}: {
  childRuns: BatchChildRun[];
  totalBatches: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const completed = childRuns.filter((c) => c.status === "COMPLETED").length;
  const failed = childRuns.filter((c) => c.status === "FAILED").length;

  return (
    <div>
      <div
        className="flex items-center gap-2 cursor-pointer select-none"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="text-xs">{expanded ? "\u25BC" : "\u25B6"}</span>
        <h4 className="font-semibold">
          Batches
        </h4>
        <span className="text-sm text-base-content/60">
          {completed}/{totalBatches} complete
          {failed > 0 && (
            <span className="text-error ml-1">({failed} failed)</span>
          )}
        </span>
      </div>
      {expanded && (
        <div className="mt-2 space-y-1">
          {childRuns.map((child) => (
            <div
              key={child.id}
              className="flex items-center gap-3 text-sm bg-base-200 rounded px-3 py-2"
            >
              <span className="font-mono text-xs w-20">
                Batch {(child.batchIndex ?? 0) + 1}
              </span>
              <StatusBadge status={child.status} />
              <span className="text-xs text-base-content/60">
                {child.currentStage ?? "-"}
              </span>
              <span className="text-xs text-base-content/60">
                {(child.filenames ?? []).length} files
              </span>
              {child.error && (
                <span className="text-error text-xs break-all" title={child.error}>
                  {child.error}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
