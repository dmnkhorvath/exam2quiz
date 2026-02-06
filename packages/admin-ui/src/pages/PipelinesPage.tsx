import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { pipelinesApi } from "../services/pipelines";

export default function PipelinesPage() {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState("");
  const [detail, setDetail] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["pipelines", filter],
    queryFn: () =>
      pipelinesApi.list({
        status: filter || undefined,
        limit: 50,
      }),
    refetchInterval: 5000,
  });

  const uploadMut = useMutation({
    mutationFn: (file: File) => pipelinesApi.upload(file),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pipelines"] });
      if (fileRef.current) fileRef.current.value = "";
    },
  });

  const cancelMut = useMutation({
    mutationFn: (id: string) => pipelinesApi.cancel(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pipelines"] }),
  });

  const runs = data?.data ?? [];

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Pipelines</h1>
        <div className="flex gap-2 items-center">
          <input
            ref={fileRef}
            type="file"
            accept=".pdf"
            className="file-input file-input-bordered file-input-sm w-64"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) uploadMut.mutate(f);
            }}
          />
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
              {runs.map((p) => (
                <tr key={p.id}>
                  <td className="font-mono text-xs max-w-48 truncate">
                    {p.filename}
                  </td>
                  <td>
                    <StatusBadge status={p.status} />
                  </td>
                  <td className="text-xs">{p.currentStage ?? "-"}</td>
                  <td>
                    <progress
                      className="progress progress-primary w-20"
                      value={p.progress}
                      max={100}
                    />
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
                  </td>
                </tr>
              ))}
              {runs.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-center text-base-content/60 py-8">
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
                <span className="text-base-content/60">File:</span>{" "}
                <span className="font-mono">{data.filename}</span>
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
