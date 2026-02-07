import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../hooks/useAuth";
import { questionsApi, type FlaggedQuestion } from "../services/questions";
import { tenantsApi } from "../services/tenants";

export default function FlaggedQuestionsPage() {
  const { isSuperAdmin } = useAuth();
  const queryClient = useQueryClient();
  const [selectedTenantId, setSelectedTenantId] = useState<string>("");
  const [editingQuestion, setEditingQuestion] = useState<FlaggedQuestion | null>(null);
  const [editForm, setEditForm] = useState<{
    question_text: string;
    correct_answer: string;
    category: string;
    subcategory: string;
  }>({ question_text: "", correct_answer: "", category: "", subcategory: "" });

  const tenantsQuery = useQuery({
    queryKey: ["tenants"],
    queryFn: tenantsApi.list,
    enabled: isSuperAdmin,
  });

  const flaggedQuery = useQuery({
    queryKey: ["flagged-questions", selectedTenantId],
    queryFn: () =>
      questionsApi.listFlagged({
        tenantId: selectedTenantId || undefined,
        limit: 100,
      }),
  });

  const reparseMutation = useMutation({
    mutationFn: (id: string) => questionsApi.reparse(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["flagged-questions"] }),
  });

  const recategorizeMutation = useMutation({
    mutationFn: (id: string) => questionsApi.recategorize(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["flagged-questions"] }),
  });

  const resolveMutation = useMutation({
    mutationFn: (id: string) => questionsApi.resolve(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["flagged-questions"] }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Parameters<typeof questionsApi.update>[1] }) =>
      questionsApi.update(id, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["flagged-questions"] });
      setEditingQuestion(null);
    },
  });

  function openEditModal(q: FlaggedQuestion) {
    setEditingQuestion(q);
    setEditForm({
      question_text: q.data?.question_text ?? "",
      correct_answer: q.data?.correct_answer ?? "",
      category: q.categorization?.category ?? "",
      subcategory: q.categorization?.subcategory ?? "",
    });
  }

  function handleSaveEdit() {
    if (!editingQuestion) return;
    const body: Parameters<typeof questionsApi.update>[1] = {};
    if (
      editForm.question_text !== (editingQuestion.data?.question_text ?? "") ||
      editForm.correct_answer !== (editingQuestion.data?.correct_answer ?? "")
    ) {
      body.data = {
        question_text: editForm.question_text,
        correct_answer: editForm.correct_answer,
      };
    }
    if (
      editForm.category !== (editingQuestion.categorization?.category ?? "") ||
      editForm.subcategory !== (editingQuestion.categorization?.subcategory ?? "")
    ) {
      body.categorization = {
        category: editForm.category,
        ...(editForm.subcategory ? { subcategory: editForm.subcategory } : {}),
      };
    }
    if (!body.data && !body.categorization) {
      setEditingQuestion(null);
      return;
    }
    updateMutation.mutate({ id: editingQuestion.id, body });
  }

  const questions = flaggedQuery.data?.questions ?? [];

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Flagged Questions</h1>
          <p className="text-sm text-base-content/60">
            Questions reported as wrong by guests
          </p>
        </div>
        {flaggedQuery.data && (
          <div className="badge badge-error badge-lg">{flaggedQuery.data.total} flagged</div>
        )}
      </div>

      {isSuperAdmin && (
        <div className="mb-4">
          <select
            className="select select-bordered select-sm w-64"
            value={selectedTenantId}
            onChange={(e) => setSelectedTenantId(e.target.value)}
          >
            <option value="">All tenants</option>
            {tenantsQuery.data?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {flaggedQuery.isLoading ? (
        <div className="flex justify-center py-12">
          <span className="loading loading-spinner loading-lg" />
        </div>
      ) : questions.length === 0 ? (
        <div className="alert alert-info">No flagged questions found.</div>
      ) : (
        <div className="space-y-4">
          {questions.map((q) => (
            <div key={q.id} className="card bg-base-100 shadow-sm border border-error/20">
              <div className="card-body p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="badge badge-error badge-sm">Flagged</span>
                      {isSuperAdmin && (
                        <span className="badge badge-outline badge-sm">{q.tenantName}</span>
                      )}
                      <span className="badge badge-ghost badge-sm">{q.file}</span>
                      {q.categorization?.category && (
                        <span className="badge badge-info badge-sm">
                          {q.categorization.category}
                          {q.categorization.subcategory && ` / ${q.categorization.subcategory}`}
                        </span>
                      )}
                      {q.markedWrongAt && (
                        <span className="text-xs text-base-content/50">
                          {new Date(q.markedWrongAt).toLocaleDateString()}
                        </span>
                      )}
                    </div>

                    {q.data?.question_text && (
                      <p className="text-sm mb-1 whitespace-pre-wrap line-clamp-3">
                        {q.data.question_text}
                      </p>
                    )}

                    {q.data?.correct_answer && (
                      <p className="text-xs text-success whitespace-pre-wrap line-clamp-2">
                        Answer: {q.data.correct_answer}
                      </p>
                    )}
                  </div>

                  <div className="flex flex-col gap-1 shrink-0">
                    <button
                      className="btn btn-xs btn-outline"
                      disabled={reparseMutation.isPending}
                      onClick={() => reparseMutation.mutate(q.id)}
                    >
                      {reparseMutation.isPending && reparseMutation.variables === q.id
                        ? "Parsing..."
                        : "Re-parse"}
                    </button>
                    <button
                      className="btn btn-xs btn-outline"
                      disabled={recategorizeMutation.isPending}
                      onClick={() => recategorizeMutation.mutate(q.id)}
                    >
                      {recategorizeMutation.isPending && recategorizeMutation.variables === q.id
                        ? "Categorizing..."
                        : "Re-categorize"}
                    </button>
                    <button
                      className="btn btn-xs btn-outline"
                      onClick={() => openEditModal(q)}
                    >
                      Edit
                    </button>
                    <button
                      className="btn btn-xs btn-success btn-outline"
                      disabled={resolveMutation.isPending}
                      onClick={() => resolveMutation.mutate(q.id)}
                    >
                      {resolveMutation.isPending && resolveMutation.variables === q.id
                        ? "Resolving..."
                        : "Resolve"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Edit Modal */}
      {editingQuestion && (
        <dialog className="modal modal-open">
          <div className="modal-box max-w-2xl">
            <h3 className="font-bold text-lg mb-4">Edit Question</h3>
            <p className="text-xs text-base-content/50 mb-4">{editingQuestion.file}</p>

            <div className="form-control mb-3">
              <label className="label">
                <span className="label-text">Question Text</span>
              </label>
              <textarea
                className="textarea textarea-bordered h-32"
                value={editForm.question_text}
                onChange={(e) => setEditForm({ ...editForm, question_text: e.target.value })}
              />
            </div>

            <div className="form-control mb-3">
              <label className="label">
                <span className="label-text">Correct Answer</span>
              </label>
              <textarea
                className="textarea textarea-bordered h-24"
                value={editForm.correct_answer}
                onChange={(e) => setEditForm({ ...editForm, correct_answer: e.target.value })}
              />
            </div>

            <div className="grid grid-cols-2 gap-3 mb-4">
              <div className="form-control">
                <label className="label">
                  <span className="label-text">Category</span>
                </label>
                <input
                  type="text"
                  className="input input-bordered input-sm"
                  value={editForm.category}
                  onChange={(e) => setEditForm({ ...editForm, category: e.target.value })}
                />
              </div>
              <div className="form-control">
                <label className="label">
                  <span className="label-text">Subcategory</span>
                </label>
                <input
                  type="text"
                  className="input input-bordered input-sm"
                  value={editForm.subcategory}
                  onChange={(e) => setEditForm({ ...editForm, subcategory: e.target.value })}
                />
              </div>
            </div>

            <div className="modal-action">
              <button className="btn btn-ghost" onClick={() => setEditingQuestion(null)}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                disabled={updateMutation.isPending}
                onClick={handleSaveEdit}
              >
                {updateMutation.isPending ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
          <div className="modal-backdrop" onClick={() => setEditingQuestion(null)} />
        </dialog>
      )}
    </div>
  );
}
