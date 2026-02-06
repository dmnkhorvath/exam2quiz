import { api } from "./api";

export interface TenantSettings {
  id: string;
  name: string;
  slug: string;
  hasGeminiApiKey: boolean;
  geminiApiKeyMasked: string | null;
}

export const tenantSettingsApi = {
  get: () => api.get<TenantSettings>("/tenant/settings"),

  update: (data: { geminiApiKey?: string | null }) =>
    api.put<TenantSettings>("/tenant/settings", data),
};
