import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../hooks/useAuth";
import { pipelinesApi } from "../services/pipelines";
import { tenantsApi } from "../services/tenants";
import { usersApi } from "../services/users";

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string | number;
  sub?: string;
}) {
  return (
    <div className="stat bg-base-100 rounded-lg shadow">
      <div className="stat-title">{label}</div>
      <div className="stat-value text-2xl">{value}</div>
      {sub && <div className="stat-desc">{sub}</div>}
    </div>
  );
}

export default function DashboardPage() {
  const { user, isSuperAdmin } = useAuth();

  const pipelines = useQuery({
    queryKey: ["pipelines"],
    queryFn: () => pipelinesApi.list({ limit: 100 }),
  });

  const tenants = useQuery({
    queryKey: ["tenants"],
    queryFn: () => tenantsApi.list(),
    enabled: isSuperAdmin,
  });

  const users = useQuery({
    queryKey: ["users"],
    queryFn: () => usersApi.list(),
    enabled: isSuperAdmin || user?.role === "TENANT_ADMIN",
  });

  const pData = pipelines.data?.data ?? [];
  const processing = pData.filter((p) => p.status === "PROCESSING").length;
  const completed = pData.filter((p) => p.status === "COMPLETED").length;
  const failed = pData.filter((p) => p.status === "FAILED").length;

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Total Pipelines"
          value={pipelines.data?.total ?? "-"}
          sub={`${processing} processing`}
        />
        <StatCard label="Completed" value={completed} sub="pipelines" />
        <StatCard label="Failed" value={failed} sub="pipelines" />

        {isSuperAdmin && (
          <StatCard
            label="Tenants"
            value={tenants.data?.length ?? "-"}
            sub={`${tenants.data?.filter((t) => t.isActive).length ?? 0} active`}
          />
        )}

        {(isSuperAdmin || user?.role === "TENANT_ADMIN") && (
          <StatCard
            label="Users"
            value={users.data?.length ?? "-"}
            sub={`${users.data?.filter((u) => u.isActive).length ?? 0} active`}
          />
        )}
      </div>

      {/* Recent pipelines */}
      <div className="card bg-base-100 shadow">
        <div className="card-body">
          <h2 className="card-title text-lg">Recent Pipelines</h2>
          {pipelines.isLoading ? (
            <div className="flex justify-center py-8">
              <span className="loading loading-spinner" />
            </div>
          ) : pData.length === 0 ? (
            <p className="text-base-content/60 py-4">No pipeline runs yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="table table-sm">
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Status</th>
                    <th>Stage</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {pData.slice(0, 10).map((p) => (
                    <tr key={p.id}>
                      <td className="font-mono text-xs">{(p.filenames ?? []).join(", ") || "-"}</td>
                      <td>
                        <StatusBadge status={p.status} />
                      </td>
                      <td className="text-xs">{p.currentStage ?? "-"}</td>
                      <td className="text-xs">
                        {new Date(p.createdAt).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
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
