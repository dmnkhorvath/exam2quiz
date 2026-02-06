import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { tenantsApi, type Tenant } from "../services/tenants";

export default function TenantsPage() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Tenant | null>(null);
  const [creating, setCreating] = useState(false);

  const { data: tenants, isLoading } = useQuery({
    queryKey: ["tenants"],
    queryFn: () => tenantsApi.list(),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => tenantsApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tenants"] }),
  });

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Tenants</h1>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => {
            setCreating(true);
            setEditing(null);
          }}
        >
          + New Tenant
        </button>
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
                <th>Name</th>
                <th>Slug</th>
                <th>Users</th>
                <th>Pipelines</th>
                <th>Max Concurrent</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {tenants?.map((t) => (
                <tr key={t.id}>
                  <td className="font-medium">{t.name}</td>
                  <td className="font-mono text-xs">{t.slug}</td>
                  <td>{t._count?.users ?? "-"}</td>
                  <td>{t._count?.pipelineRuns ?? "-"}</td>
                  <td>{t.maxConcurrentPipelines}</td>
                  <td>
                    <span
                      className={`badge badge-sm ${t.isActive ? "badge-success" : "badge-error"}`}
                    >
                      {t.isActive ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="space-x-1">
                    <button
                      className="btn btn-ghost btn-xs"
                      onClick={() => {
                        setEditing(t);
                        setCreating(false);
                      }}
                    >
                      Edit
                    </button>
                    <button
                      className="btn btn-ghost btn-xs text-error"
                      onClick={() => {
                        if (confirm(`Deactivate tenant "${t.name}"?`))
                          deleteMut.mutate(t.id);
                      }}
                    >
                      Deactivate
                    </button>
                  </td>
                </tr>
              ))}
              {tenants?.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-center text-base-content/60 py-8">
                    No tenants yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {(creating || editing) && (
        <TenantForm
          tenant={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function TenantForm({
  tenant,
  onClose,
}: {
  tenant: Tenant | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: tenant?.name ?? "",
    slug: tenant?.slug ?? "",
    geminiApiKey: tenant?.geminiApiKey ?? "",
    maxConcurrentPipelines: tenant?.maxConcurrentPipelines ?? 2,
    storageQuotaMb: tenant?.storageQuotaMb ?? 5120,
    isActive: tenant?.isActive ?? true,
  });
  const [error, setError] = useState("");

  const mutation = useMutation({
    mutationFn: () =>
      tenant
        ? tenantsApi.update(tenant.id, form)
        : tenantsApi.create(form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tenants"] });
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div className="modal modal-open">
      <div className="modal-box">
        <h3 className="font-bold text-lg">
          {tenant ? "Edit Tenant" : "New Tenant"}
        </h3>

        {error && <div className="alert alert-error text-sm mt-2">{error}</div>}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate();
          }}
          className="mt-4 space-y-3"
        >
          <div className="form-control">
            <label className="label"><span className="label-text">Name</span></label>
            <input
              className="input input-bordered w-full"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          </div>

          <div className="form-control">
            <label className="label"><span className="label-text">Slug</span></label>
            <input
              className="input input-bordered w-full"
              value={form.slug}
              onChange={(e) => setForm({ ...form, slug: e.target.value })}
              required
              pattern="[a-z0-9-]+"
            />
          </div>

          <div className="form-control">
            <label className="label"><span className="label-text">Gemini API Key</span></label>
            <input
              className="input input-bordered w-full"
              type="password"
              value={form.geminiApiKey}
              onChange={(e) => setForm({ ...form, geminiApiKey: e.target.value })}
              placeholder="Optional"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="form-control">
              <label className="label"><span className="label-text">Max Concurrent</span></label>
              <input
                className="input input-bordered w-full"
                type="number"
                min={1}
                value={form.maxConcurrentPipelines}
                onChange={(e) =>
                  setForm({ ...form, maxConcurrentPipelines: +e.target.value })
                }
              />
            </div>
            <div className="form-control">
              <label className="label"><span className="label-text">Storage (MB)</span></label>
              <input
                className="input input-bordered w-full"
                type="number"
                min={100}
                value={form.storageQuotaMb}
                onChange={(e) =>
                  setForm({ ...form, storageQuotaMb: +e.target.value })
                }
              />
            </div>
          </div>

          {tenant && (
            <div className="form-control">
              <label className="label cursor-pointer">
                <span className="label-text">Active</span>
                <input
                  type="checkbox"
                  className="toggle toggle-primary"
                  checked={form.isActive}
                  onChange={(e) =>
                    setForm({ ...form, isActive: e.target.checked })
                  }
                />
              </label>
            </div>
          )}

          <div className="modal-action">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={mutation.isPending}
            >
              {mutation.isPending && (
                <span className="loading loading-spinner loading-sm" />
              )}
              {tenant ? "Save" : "Create"}
            </button>
          </div>
        </form>
      </div>
      <div className="modal-backdrop" onClick={onClose} />
    </div>
  );
}
