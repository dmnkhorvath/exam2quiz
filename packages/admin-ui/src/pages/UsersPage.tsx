import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { usersApi } from "../services/users";
import { tenantsApi } from "../services/tenants";
import { useAuth } from "../hooks/useAuth";

export default function UsersPage() {
  const qc = useQueryClient();
  const { isSuperAdmin } = useAuth();
  const [creating, setCreating] = useState(false);
  const [changingPasswordFor, setChangingPasswordFor] = useState<{
    id: string;
    email: string;
  } | null>(null);

  const { data: users, isLoading } = useQuery({
    queryKey: ["users"],
    queryFn: () => usersApi.list(),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => usersApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });

  const toggleMut = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      usersApi.update(id, { isActive }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Users</h1>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => setCreating(true)}
        >
          + New User
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
                <th>Email</th>
                <th>Name</th>
                <th>Role</th>
                {isSuperAdmin && <th>Tenant</th>}
                <th>Status</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users?.map((u) => (
                <tr key={u.id}>
                  <td className="font-mono text-xs">{u.email}</td>
                  <td>{u.name ?? "-"}</td>
                  <td>
                    <span className="badge badge-sm badge-outline">
                      {u.role.replace(/_/g, " ")}
                    </span>
                  </td>
                  {isSuperAdmin && (
                    <td className="text-xs">{u.tenantId ?? "None"}</td>
                  )}
                  <td>
                    <span
                      className={`badge badge-sm ${u.isActive ? "badge-success" : "badge-error"}`}
                    >
                      {u.isActive ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="text-xs">
                    {new Date(u.createdAt).toLocaleDateString()}
                  </td>
                  <td className="space-x-1">
                    {isSuperAdmin && (
                      <button
                        className="btn btn-ghost btn-xs"
                        onClick={() =>
                          setChangingPasswordFor({
                            id: u.id,
                            email: u.email,
                          })
                        }
                      >
                        Password
                      </button>
                    )}
                    <button
                      className="btn btn-ghost btn-xs"
                      onClick={() =>
                        toggleMut.mutate({
                          id: u.id,
                          isActive: !u.isActive,
                        })
                      }
                    >
                      {u.isActive ? "Disable" : "Enable"}
                    </button>
                    <button
                      className="btn btn-ghost btn-xs text-error"
                      onClick={() => {
                        if (confirm(`Deactivate "${u.email}"?`))
                          deleteMut.mutate(u.id);
                      }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
              {users?.length === 0 && (
                <tr>
                  <td
                    colSpan={isSuperAdmin ? 7 : 6}
                    className="text-center text-base-content/60 py-8"
                  >
                    No users found
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {creating && <CreateUserModal onClose={() => setCreating(false)} />}
      {changingPasswordFor && (
        <ChangePasswordModal
          userId={changingPasswordFor.id}
          userEmail={changingPasswordFor.email}
          onClose={() => setChangingPasswordFor(null)}
        />
      )}
    </div>
  );
}

function ChangePasswordModal({
  userId,
  userEmail,
  onClose,
}: {
  userId: string;
  userEmail: string;
  onClose: () => void;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");

  const mutation = useMutation({
    mutationFn: () => usersApi.changePassword(userId, password),
    onSuccess: () => onClose(),
    onError: (err: Error) => setError(err.message),
  });

  const mismatch = confirm.length > 0 && password !== confirm;

  return (
    <div className="modal modal-open">
      <div className="modal-box">
        <h3 className="font-bold text-lg">Change Password</h3>
        <p className="text-sm text-base-content/60 mt-1">{userEmail}</p>
        {error && <div className="alert alert-error text-sm mt-2">{error}</div>}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (password !== confirm) {
              setError("Passwords do not match");
              return;
            }
            mutation.mutate();
          }}
          className="mt-4 space-y-3"
        >
          <div className="form-control">
            <label className="label">
              <span className="label-text">New Password</span>
            </label>
            <input
              className="input input-bordered w-full"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
            />
          </div>

          <div className="form-control">
            <label className="label">
              <span className="label-text">Confirm Password</span>
            </label>
            <input
              className={`input input-bordered w-full ${mismatch ? "input-error" : ""}`}
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              minLength={8}
            />
            {mismatch && (
              <label className="label">
                <span className="label-text-alt text-error">
                  Passwords do not match
                </span>
              </label>
            )}
          </div>

          <div className="modal-action">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={mutation.isPending || mismatch}
            >
              {mutation.isPending && (
                <span className="loading loading-spinner loading-sm" />
              )}
              Change Password
            </button>
          </div>
        </form>
      </div>
      <div className="modal-backdrop" onClick={onClose} />
    </div>
  );
}

function CreateUserModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { isSuperAdmin } = useAuth();
  const [form, setForm] = useState({
    email: "",
    password: "",
    name: "",
    role: "TENANT_USER",
    tenantId: "",
  });
  const [error, setError] = useState("");

  const { data: tenants } = useQuery({
    queryKey: ["tenants"],
    queryFn: () => tenantsApi.list(),
    enabled: isSuperAdmin,
  });

  const mutation = useMutation({
    mutationFn: () =>
      usersApi.create({
        ...form,
        name: form.name || undefined,
        tenantId: form.tenantId || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] });
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div className="modal modal-open">
      <div className="modal-box">
        <h3 className="font-bold text-lg">New User</h3>
        {error && <div className="alert alert-error text-sm mt-2">{error}</div>}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate();
          }}
          className="mt-4 space-y-3"
        >
          <div className="form-control">
            <label className="label"><span className="label-text">Email</span></label>
            <input
              className="input input-bordered w-full"
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              required
            />
          </div>

          <div className="form-control">
            <label className="label"><span className="label-text">Password</span></label>
            <input
              className="input input-bordered w-full"
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              required
              minLength={8}
            />
          </div>

          <div className="form-control">
            <label className="label"><span className="label-text">Name</span></label>
            <input
              className="input input-bordered w-full"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>

          {isSuperAdmin && (
            <>
              <div className="form-control">
                <label className="label"><span className="label-text">Role</span></label>
                <select
                  className="select select-bordered w-full"
                  value={form.role}
                  onChange={(e) => setForm({ ...form, role: e.target.value })}
                >
                  <option value="TENANT_USER">Tenant User</option>
                  <option value="TENANT_ADMIN">Tenant Admin</option>
                  <option value="SUPER_ADMIN">Super Admin</option>
                </select>
              </div>

              <div className="form-control">
                <label className="label"><span className="label-text">Tenant</span></label>
                <select
                  className="select select-bordered w-full"
                  value={form.tenantId}
                  onChange={(e) =>
                    setForm({ ...form, tenantId: e.target.value })
                  }
                >
                  <option value="">No tenant</option>
                  {tenants?.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>
            </>
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
              Create
            </button>
          </div>
        </form>
      </div>
      <div className="modal-backdrop" onClick={onClose} />
    </div>
  );
}
