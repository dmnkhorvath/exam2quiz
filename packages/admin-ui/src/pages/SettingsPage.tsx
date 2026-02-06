import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { tenantSettingsApi } from "../services/tenant-settings";
import { useAuth } from "../hooks/useAuth";

export default function SettingsPage() {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [success, setSuccess] = useState("");

  const { data: settings, isLoading } = useQuery({
    queryKey: ["tenant-settings"],
    queryFn: () => tenantSettingsApi.get(),
  });

  const mutation = useMutation({
    mutationFn: (data: { geminiApiKey?: string | null }) =>
      tenantSettingsApi.update(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tenant-settings"] });
      setEditing(false);
      setApiKey("");
      setSuccess("Gemini API key updated successfully.");
      setTimeout(() => setSuccess(""), 3000);
    },
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <span className="loading loading-spinner" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold">Tenant Settings</h1>

      {settings && (
        <div className="card bg-base-100 shadow">
          <div className="card-body space-y-4">
            <div>
              <div className="text-sm text-base-content/60">Tenant</div>
              <div className="font-medium">{settings.name}</div>
              <div className="text-xs font-mono text-base-content/50">{settings.slug}</div>
            </div>

            <div className="divider my-0" />

            <div>
              <div className="text-sm text-base-content/60 mb-1">Gemini API Key</div>
              {!editing ? (
                <div className="flex items-center gap-3">
                  {settings.hasGeminiApiKey ? (
                    <code className="text-sm bg-base-200 px-2 py-1 rounded">
                      {settings.geminiApiKeyMasked}
                    </code>
                  ) : (
                    <span className="text-sm text-base-content/40 italic">
                      Not configured
                    </span>
                  )}
                  {isAdmin && (
                    <button
                      className="btn btn-ghost btn-xs"
                      onClick={() => setEditing(true)}
                    >
                      Edit
                    </button>
                  )}
                </div>
              ) : (
                <ApiKeyForm
                  hasExisting={settings.hasGeminiApiKey}
                  apiKey={apiKey}
                  onApiKeyChange={setApiKey}
                  onSave={() => mutation.mutate({ geminiApiKey: apiKey || null })}
                  onRemove={() => mutation.mutate({ geminiApiKey: null })}
                  onCancel={() => { setEditing(false); setApiKey(""); }}
                  isPending={mutation.isPending}
                />
              )}
            </div>

            {success && <div className="alert alert-success text-sm">{success}</div>}
            {mutation.error && (
              <div className="alert alert-error text-sm">
                {(mutation.error as Error).message}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ApiKeyForm({
  hasExisting,
  apiKey,
  onApiKeyChange,
  onSave,
  onRemove,
  onCancel,
  isPending,
}: {
  hasExisting: boolean;
  apiKey: string;
  onApiKeyChange: (v: string) => void;
  onSave: () => void;
  onRemove: () => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  return (
    <div className="space-y-2">
      <input
        className="input input-bordered w-full"
        type="password"
        placeholder="Enter new Gemini API key"
        value={apiKey}
        onChange={(e) => onApiKeyChange(e.target.value)}
        autoFocus
      />
      <div className="flex gap-2">
        <button
          className="btn btn-primary btn-sm"
          onClick={onSave}
          disabled={isPending || !apiKey}
        >
          {isPending && <span className="loading loading-spinner loading-sm" />}
          Save
        </button>
        {hasExisting && (
          <button
            className="btn btn-error btn-outline btn-sm"
            onClick={() => {
              if (confirm("Remove the Gemini API key? Pipelines will use the system default key."))
                onRemove();
            }}
            disabled={isPending}
          >
            Remove Key
          </button>
        )}
        <button className="btn btn-ghost btn-sm" onClick={onCancel} disabled={isPending}>
          Cancel
        </button>
      </div>
    </div>
  );
}
