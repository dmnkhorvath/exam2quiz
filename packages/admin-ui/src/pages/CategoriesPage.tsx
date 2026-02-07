import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { categoriesApi, type Category } from "../services/categories";
import { tenantsApi } from "../services/tenants";
import { useAuth } from "../hooks/useAuth";

/** Group categories by name for the grouped display. */
interface CategoryGroup {
  name: string;
  rows: Category[];
}

function groupCategories(categories: Category[]): CategoryGroup[] {
  const map = new Map<string, Category[]>();
  for (const c of categories) {
    const rows = map.get(c.name) ?? [];
    rows.push(c);
    map.set(c.name, rows);
  }
  return [...map.entries()]
    .map(([name, rows]) => ({
      name,
      rows: rows.sort((a, b) => (a.subcategory ?? "").localeCompare(b.subcategory ?? "")),
    }))
    .sort((a, b) => {
      const aMin = Math.min(...a.rows.map((r) => r.sortOrder));
      const bMin = Math.min(...b.rows.map((r) => r.sortOrder));
      return aMin - bMin;
    });
}

export default function CategoriesPage() {
  const qc = useQueryClient();
  const { isSuperAdmin, user } = useAuth();
  const [editing, setEditing] = useState<Category | null>(null);
  const [creating, setCreating] = useState(false);
  const [addingSubTo, setAddingSubTo] = useState<CategoryGroup | null>(null);
  const [selectedTenantId, setSelectedTenantId] = useState<string>(user?.tenantId ?? "");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const { data: tenants } = useQuery({
    queryKey: ["tenants"],
    queryFn: () => tenantsApi.list(),
    enabled: isSuperAdmin,
  });

  const effectiveTenantId = selectedTenantId || (isSuperAdmin ? tenants?.[0]?.id : user?.tenantId) || "";

  const { data: categories, isLoading } = useQuery({
    queryKey: ["categories", effectiveTenantId],
    queryFn: () => categoriesApi.list(effectiveTenantId || undefined),
    enabled: !!effectiveTenantId || isSuperAdmin,
  });

  const groups = useMemo(
    () => groupCategories(categories ?? []),
    [categories],
  );

  const deleteMut = useMutation({
    mutationFn: (id: string) => categoriesApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["categories"] }),
  });

  const toggleGroup = (name: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Categories</h1>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => {
            setCreating(true);
            setEditing(null);
            setAddingSubTo(null);
          }}
        >
          + New Category
        </button>
      </div>

      {isSuperAdmin && tenants && tenants.length > 0 && (
        <div className="form-control w-full max-w-xs">
          <label className="label"><span className="label-text">Tenant</span></label>
          <select
            className="select select-bordered"
            value={effectiveTenantId}
            onChange={(e) => setSelectedTenantId(e.target.value)}
          >
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-12">
          <span className="loading loading-spinner" />
        </div>
      ) : groups.length === 0 ? (
        <div className="text-center text-base-content/60 py-12">
          No categories configured
        </div>
      ) : (
        <div className="space-y-2">
          {groups.map((group) => {
            const hasSubcategories = group.rows.some((r) => r.subcategory);
            const isExpanded = expandedGroups.has(group.name);
            // Use the first row's data as the "category-level" representative
            const first = group.rows[0];

            return (
              <div key={group.name} className="bg-base-100 rounded-lg shadow overflow-hidden">
                {/* Category header row */}
                <div
                  className={`flex items-center gap-3 px-4 py-3 ${hasSubcategories ? "cursor-pointer hover:bg-base-200/50" : ""}`}
                  onClick={() => hasSubcategories && toggleGroup(group.name)}
                >
                  {/* Expand/collapse indicator */}
                  <span className="w-5 text-center text-base-content/40 text-sm">
                    {hasSubcategories ? (isExpanded ? "\u25BC" : "\u25B6") : "\u2022"}
                  </span>

                  {/* Sort order */}
                  <span className="text-xs text-base-content/50 w-8">{first.sortOrder}</span>

                  {/* Key */}
                  <span className="font-mono text-xs text-base-content/60 w-24 truncate">{first.key}</span>

                  {/* Name */}
                  <span className="font-semibold flex-1">{group.name}</span>

                  {/* Subcategory count badge */}
                  {hasSubcategories && (
                    <span className="badge badge-sm badge-ghost">
                      {group.rows.filter((r) => r.subcategory).length} subcategories
                    </span>
                  )}

                  {/* File (shown for categories without subcategories) */}
                  {!hasSubcategories && (
                    <span className="font-mono text-xs text-base-content/50">{first.file}</span>
                  )}

                  {/* Actions */}
                  <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                    <button
                      className="btn btn-ghost btn-xs"
                      title="Add subcategory"
                      onClick={() => {
                        setAddingSubTo(group);
                        setCreating(false);
                        setEditing(null);
                      }}
                    >
                      + Sub
                    </button>
                    {!hasSubcategories && (
                      <>
                        <button
                          className="btn btn-ghost btn-xs"
                          onClick={() => {
                            setEditing(first);
                            setCreating(false);
                            setAddingSubTo(null);
                          }}
                        >
                          Edit
                        </button>
                        <button
                          className="btn btn-ghost btn-xs text-error"
                          onClick={() => {
                            if (confirm(`Delete category "${group.name}"?`))
                              deleteMut.mutate(first.id);
                          }}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* Subcategory rows (expanded) */}
                {hasSubcategories && isExpanded && (
                  <div className="border-t border-base-200">
                    {group.rows.map((row) => (
                      <div
                        key={row.id}
                        className="flex items-center gap-3 px-4 py-2 pl-12 hover:bg-base-200/30 border-b border-base-200 last:border-b-0"
                      >
                        <span className="text-xs text-base-content/50 w-8">{row.sortOrder}</span>
                        <span className="font-mono text-xs text-base-content/60 w-24 truncate">{row.key}</span>
                        <span className="flex-1 text-sm">
                          {row.subcategory ?? <span className="text-base-content/30 italic">no subcategory</span>}
                        </span>
                        <span className="font-mono text-xs text-base-content/50">{row.file}</span>
                        <div className="flex gap-1">
                          <button
                            className="btn btn-ghost btn-xs"
                            onClick={() => {
                              setEditing(row);
                              setCreating(false);
                              setAddingSubTo(null);
                            }}
                          >
                            Edit
                          </button>
                          <button
                            className="btn btn-ghost btn-xs text-error"
                            onClick={() => {
                              if (confirm(`Delete "${row.subcategory ?? row.name}"?`))
                                deleteMut.mutate(row.id);
                            }}
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Create new category modal */}
      {creating && (
        <CategoryCreateForm
          tenantId={effectiveTenantId}
          onClose={() => setCreating(false)}
        />
      )}

      {/* Edit single category row modal */}
      {editing && (
        <CategoryEditForm
          category={editing}
          onClose={() => setEditing(null)}
        />
      )}

      {/* Add subcategory to existing group modal */}
      {addingSubTo && (
        <SubcategoryAddForm
          group={addingSubTo}
          tenantId={effectiveTenantId}
          onClose={() => setAddingSubTo(null)}
        />
      )}
    </div>
  );
}

// ─── Create Category Form (supports multiple subcategories) ──────
function CategoryCreateForm({
  tenantId,
  onClose,
}: {
  tenantId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [file, setFile] = useState("");
  const [sortOrder, setSortOrder] = useState(0);
  const [subcategories, setSubcategories] = useState<string[]>([]);
  const [subInput, setSubInput] = useState("");
  const [error, setError] = useState("");

  const mutation = useMutation({
    mutationFn: async () => {
      if (subcategories.length === 0) {
        // Single category, no subcategories
        return categoriesApi.create({ key, name, file, sortOrder, tenantId });
      }
      // Create one row per subcategory
      const results = [];
      for (const sub of subcategories) {
        const subKey = `${key}:${sub.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;
        const subFile = `${file.replace(/\.\w+$/, "")}_${sub.toLowerCase().replace(/[^a-z0-9]/g, "_")}.json`;
        results.push(
          await categoriesApi.create({
            key: subKey,
            name,
            subcategory: sub,
            file: subFile,
            sortOrder,
            tenantId,
          }),
        );
      }
      return results;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["categories"] });
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  const addSubcategory = () => {
    const trimmed = subInput.trim();
    if (trimmed && !subcategories.includes(trimmed)) {
      setSubcategories([...subcategories, trimmed]);
      setSubInput("");
    }
  };

  const removeSubcategory = (sub: string) => {
    setSubcategories(subcategories.filter((s) => s !== sub));
  };

  return (
    <div className="modal modal-open">
      <div className="modal-box">
        <h3 className="font-bold text-lg">New Category</h3>
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
              value={key}
              onChange={(e) => setKey(e.target.value)}
              required
              placeholder="e.g. anatomy"
            />
            <label className="label">
              <span className="label-text-alt text-base-content/50">
                {subcategories.length > 0
                  ? "Used as prefix — subcategory keys will be auto-generated"
                  : "Unique identifier for this category"}
              </span>
            </label>
          </div>

          <div className="form-control">
            <label className="label"><span className="label-text">Name</span></label>
            <input
              className="input input-bordered w-full"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="e.g. Anatomy"
            />
          </div>

          <div className="form-control">
            <label className="label"><span className="label-text">Output File</span></label>
            <input
              className="input input-bordered w-full"
              value={file}
              onChange={(e) => setFile(e.target.value)}
              required
              placeholder={subcategories.length > 0 ? "e.g. anatomy (prefix, auto-suffixed)" : "e.g. anatomy.json"}
            />
            {subcategories.length > 0 && (
              <label className="label">
                <span className="label-text-alt text-base-content/50">
                  Each subcategory gets its own file based on this prefix
                </span>
              </label>
            )}
          </div>

          <div className="form-control">
            <label className="label"><span className="label-text">Sort Order</span></label>
            <input
              className="input input-bordered w-full"
              type="number"
              value={sortOrder}
              onChange={(e) => setSortOrder(+e.target.value)}
            />
          </div>

          {/* Subcategories section */}
          <div className="form-control">
            <label className="label"><span className="label-text">Subcategories</span></label>

            {/* Tag display */}
            {subcategories.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {subcategories.map((sub) => (
                  <span key={sub} className="badge badge-lg gap-1">
                    {sub}
                    <button
                      type="button"
                      className="text-base-content/50 hover:text-error"
                      onClick={() => removeSubcategory(sub)}
                    >
                      x
                    </button>
                  </span>
                ))}
              </div>
            )}

            {/* Add subcategory input */}
            <div className="flex gap-2">
              <input
                className="input input-bordered flex-1"
                value={subInput}
                onChange={(e) => setSubInput(e.target.value)}
                placeholder="e.g. Musculoskeletal"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addSubcategory();
                  }
                }}
              />
              <button
                type="button"
                className="btn btn-outline btn-sm self-center"
                onClick={addSubcategory}
                disabled={!subInput.trim()}
              >
                Add
              </button>
            </div>
            <label className="label">
              <span className="label-text-alt text-base-content/50">
                Press Enter or click Add. Leave empty for a category without subcategories.
              </span>
            </label>
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
              {subcategories.length > 0
                ? `Create ${subcategories.length} Subcategories`
                : "Create"}
            </button>
          </div>
        </form>
      </div>
      <div className="modal-backdrop" onClick={onClose} />
    </div>
  );
}

// ─── Edit Single Category Row ────────────────────────────────────
function CategoryEditForm({
  category,
  onClose,
}: {
  category: Category;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    key: category.key,
    name: category.name,
    subcategory: category.subcategory ?? "",
    file: category.file,
    sortOrder: category.sortOrder,
  });
  const [error, setError] = useState("");

  const mutation = useMutation({
    mutationFn: () =>
      categoriesApi.update(category.id, {
        ...form,
        subcategory: form.subcategory || null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["categories"] });
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div className="modal modal-open">
      <div className="modal-box">
        <h3 className="font-bold text-lg">Edit Category</h3>
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
            />
          </div>

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
            <label className="label"><span className="label-text">Subcategory</span></label>
            <input
              className="input input-bordered w-full"
              value={form.subcategory}
              onChange={(e) => setForm({ ...form, subcategory: e.target.value })}
              placeholder="Optional"
            />
          </div>

          <div className="form-control">
            <label className="label"><span className="label-text">Output File</span></label>
            <input
              className="input input-bordered w-full"
              value={form.file}
              onChange={(e) => setForm({ ...form, file: e.target.value })}
              required
            />
          </div>

          <div className="form-control">
            <label className="label"><span className="label-text">Sort Order</span></label>
            <input
              className="input input-bordered w-full"
              type="number"
              value={form.sortOrder}
              onChange={(e) => setForm({ ...form, sortOrder: +e.target.value })}
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
              Save
            </button>
          </div>
        </form>
      </div>
      <div className="modal-backdrop" onClick={onClose} />
    </div>
  );
}

// ─── Add Subcategory to Existing Group ───────────────────────────
function SubcategoryAddForm({
  group,
  tenantId,
  onClose,
}: {
  group: CategoryGroup;
  tenantId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const first = group.rows[0];
  const [subcategories, setSubcategories] = useState<string[]>([]);
  const [subInput, setSubInput] = useState("");
  const [error, setError] = useState("");

  const mutation = useMutation({
    mutationFn: async () => {
      const results = [];
      for (const sub of subcategories) {
        // Derive key and file from the category's base key
        const baseKey = first.key.includes(":") ? first.key.split(":")[0] : first.key;
        const subKey = `${baseKey}:${sub.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;
        const baseFile = first.file.replace(/(_[^.]*)?\.(\w+)$/, "");
        const ext = first.file.match(/\.(\w+)$/)?.[1] ?? "json";
        const subFile = `${baseFile}_${sub.toLowerCase().replace(/[^a-z0-9]/g, "_")}.${ext}`;
        results.push(
          await categoriesApi.create({
            key: subKey,
            name: group.name,
            subcategory: sub,
            file: subFile,
            sortOrder: first.sortOrder,
            tenantId,
          }),
        );
      }
      return results;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["categories"] });
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  const addSubcategory = () => {
    const trimmed = subInput.trim();
    if (trimmed && !subcategories.includes(trimmed)) {
      setSubcategories([...subcategories, trimmed]);
      setSubInput("");
    }
  };

  const removeSubcategory = (sub: string) => {
    setSubcategories(subcategories.filter((s) => s !== sub));
  };

  // Existing subcategories in this group
  const existingSubs = group.rows
    .map((r) => r.subcategory)
    .filter(Boolean) as string[];

  return (
    <div className="modal modal-open">
      <div className="modal-box">
        <h3 className="font-bold text-lg">
          Add Subcategories to "{group.name}"
        </h3>
        {error && <div className="alert alert-error text-sm mt-2">{error}</div>}

        {/* Show existing subcategories */}
        {existingSubs.length > 0 && (
          <div className="mt-3">
            <span className="text-xs text-base-content/50 uppercase tracking-wide">Existing</span>
            <div className="flex flex-wrap gap-1.5 mt-1">
              {existingSubs.map((sub) => (
                <span key={sub} className="badge badge-ghost badge-sm">{sub}</span>
              ))}
            </div>
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (subcategories.length > 0) mutation.mutate();
          }}
          className="mt-4 space-y-3"
        >
          {/* New subcategories */}
          {subcategories.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {subcategories.map((sub) => (
                <span key={sub} className="badge badge-lg badge-primary gap-1">
                  {sub}
                  <button
                    type="button"
                    className="text-primary-content/50 hover:text-primary-content"
                    onClick={() => removeSubcategory(sub)}
                  >
                    x
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <input
              className="input input-bordered flex-1"
              value={subInput}
              onChange={(e) => setSubInput(e.target.value)}
              placeholder="e.g. Neuroanatomy"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addSubcategory();
                }
              }}
              autoFocus
            />
            <button
              type="button"
              className="btn btn-outline btn-sm self-center"
              onClick={addSubcategory}
              disabled={!subInput.trim()}
            >
              Add
            </button>
          </div>

          <div className="modal-action">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={mutation.isPending || subcategories.length === 0}
            >
              {mutation.isPending && (
                <span className="loading loading-spinner loading-sm" />
              )}
              Create {subcategories.length} Subcategor{subcategories.length === 1 ? "y" : "ies"}
            </button>
          </div>
        </form>
      </div>
      <div className="modal-backdrop" onClick={onClose} />
    </div>
  );
}
