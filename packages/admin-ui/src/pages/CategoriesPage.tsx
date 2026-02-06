import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { categoriesApi, type Category } from "../services/categories";

export default function CategoriesPage() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Category | null>(null);
  const [creating, setCreating] = useState(false);

  const { data: categories, isLoading } = useQuery({
    queryKey: ["categories"],
    queryFn: () => categoriesApi.list(),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => categoriesApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["categories"] }),
  });

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Categories</h1>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => {
            setCreating(true);
            setEditing(null);
          }}
        >
          + New Category
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
                <th>Order</th>
                <th>Key</th>
                <th>Name</th>
                <th>File</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {categories
                ?.sort((a, b) => a.sortOrder - b.sortOrder)
                .map((c) => (
                  <tr key={c.id}>
                    <td>{c.sortOrder}</td>
                    <td className="font-mono text-xs">{c.key}</td>
                    <td className="font-medium">{c.name}</td>
                    <td className="font-mono text-xs">{c.file}</td>
                    <td className="space-x-1">
                      <button
                        className="btn btn-ghost btn-xs"
                        onClick={() => {
                          setEditing(c);
                          setCreating(false);
                        }}
                      >
                        Edit
                      </button>
                      <button
                        className="btn btn-ghost btn-xs text-error"
                        onClick={() => {
                          if (confirm(`Delete category "${c.name}"?`))
                            deleteMut.mutate(c.id);
                        }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              {categories?.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-center text-base-content/60 py-8">
                    No categories configured
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {(creating || editing) && (
        <CategoryForm
          category={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function CategoryForm({
  category,
  onClose,
}: {
  category: Category | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    key: category?.key ?? "",
    name: category?.name ?? "",
    file: category?.file ?? "",
    sortOrder: category?.sortOrder ?? 0,
  });
  const [error, setError] = useState("");

  const mutation = useMutation({
    mutationFn: () =>
      category
        ? categoriesApi.update(category.id, form)
        : categoriesApi.create(form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["categories"] });
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div className="modal modal-open">
      <div className="modal-box">
        <h3 className="font-bold text-lg">
          {category ? "Edit Category" : "New Category"}
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
            <label className="label"><span className="label-text">Key</span></label>
            <input
              className="input input-bordered w-full"
              value={form.key}
              onChange={(e) => setForm({ ...form, key: e.target.value })}
              required
              placeholder="e.g. anatomy"
            />
          </div>

          <div className="form-control">
            <label className="label"><span className="label-text">Name</span></label>
            <input
              className="input input-bordered w-full"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
              placeholder="e.g. Anatomy"
            />
          </div>

          <div className="form-control">
            <label className="label"><span className="label-text">Output File</span></label>
            <input
              className="input input-bordered w-full"
              value={form.file}
              onChange={(e) => setForm({ ...form, file: e.target.value })}
              required
              placeholder="e.g. anatomy.md"
            />
          </div>

          <div className="form-control">
            <label className="label"><span className="label-text">Sort Order</span></label>
            <input
              className="input input-bordered w-full"
              type="number"
              value={form.sortOrder}
              onChange={(e) =>
                setForm({ ...form, sortOrder: +e.target.value })
              }
            />
          </div>

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
              {category ? "Save" : "Create"}
            </button>
          </div>
        </form>
      </div>
      <div className="modal-backdrop" onClick={onClose} />
    </div>
  );
}
