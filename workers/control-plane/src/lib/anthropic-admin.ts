/**
 * Anthropic Admin API client.
 * Manages per-tenant workspaces and API key lifecycle.
 *
 * NOTE: The Admin API does NOT support creating API keys programmatically.
 * Keys must be created manually in the Claude Console.
 * This client automates workspace creation, key listing/deactivation, and cleanup.
 *
 * Docs: https://docs.anthropic.com/en/api/administration-api
 */

const ANTHROPIC_ADMIN_BASE = "https://api.anthropic.com/v1";

// ── Response types ──────────────────────────────────────────────────

export interface Workspace {
  id: string;
  name: string;
  type: "workspace";
  created_at: string;
  archived_at: string | null;
  display_color: string;
}

export interface APIKey {
  id: string;
  name: string;
  type: "api_key";
  status: "active" | "inactive" | "archived";
  partial_key_hint: string;
  workspace_id: string | null;
  created_at: string;
  created_by: {
    id: string;
    type: string;
  };
}

interface PaginatedResponse<T> {
  data: T[];
  has_more: boolean;
  first_id: string | null;
  last_id: string | null;
}

// ── Client ──────────────────────────────────────────────────────────

export class AnthropicAdminClient {
  constructor(private apiKey: string) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const init: RequestInit = {
      method,
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
    };
    if (body) init.body = JSON.stringify(body);

    const resp = await fetch(`${ANTHROPIC_ADMIN_BASE}${path}`, init);

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(
        `Anthropic Admin API ${method} ${path} failed (${resp.status}): ${text}`,
      );
    }

    if (resp.status === 204) return undefined as T;
    return resp.json() as Promise<T>;
  }

  // ── Workspaces ──────────────────────────────────────────────────

  /** Create a workspace for a tenant. */
  async createWorkspace(name: string): Promise<Workspace> {
    return this.request<Workspace>(
      "POST",
      "/organizations/workspaces",
      { name },
    );
  }

  /** Get workspace details. */
  async getWorkspace(workspaceId: string): Promise<Workspace> {
    return this.request<Workspace>(
      "GET",
      `/organizations/workspaces/${workspaceId}`,
    );
  }

  /** Archive a workspace (soft delete). */
  async archiveWorkspace(workspaceId: string): Promise<Workspace> {
    return this.request<Workspace>(
      "POST",
      `/organizations/workspaces/${workspaceId}/archive`,
    );
  }

  /** List workspaces with optional pagination. */
  async listWorkspaces(opts?: {
    limit?: number;
    includeArchived?: boolean;
    afterId?: string;
  }): Promise<PaginatedResponse<Workspace>> {
    const params = new URLSearchParams();
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.includeArchived) params.set("include_archived", "true");
    if (opts?.afterId) params.set("after_id", opts.afterId);
    const qs = params.toString();
    return this.request<PaginatedResponse<Workspace>>(
      "GET",
      `/organizations/workspaces${qs ? `?${qs}` : ""}`,
    );
  }

  // ── API Keys ──────────────────────────────────────────────────

  /**
   * List API keys, optionally filtered by workspace and/or status.
   * NOTE: The Admin API does NOT return actual key values — only metadata
   * and a partial hint (e.g. "sk-ant-...1234").
   */
  async listAPIKeys(opts?: {
    workspaceId?: string;
    status?: "active" | "inactive" | "archived";
    limit?: number;
    afterId?: string;
  }): Promise<PaginatedResponse<APIKey>> {
    const params = new URLSearchParams();
    if (opts?.workspaceId) params.set("workspace_id", opts.workspaceId);
    if (opts?.status) params.set("status", opts.status);
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.afterId) params.set("after_id", opts.afterId);
    const qs = params.toString();
    return this.request<PaginatedResponse<APIKey>>(
      "GET",
      `/organizations/api_keys${qs ? `?${qs}` : ""}`,
    );
  }

  /** Get a single API key by ID. */
  async getAPIKey(apiKeyId: string): Promise<APIKey> {
    return this.request<APIKey>(
      "GET",
      `/organizations/api_keys/${apiKeyId}`,
    );
  }

  /** Update an API key's name or status. */
  async updateAPIKey(
    apiKeyId: string,
    update: { name?: string; status?: "active" | "inactive" | "archived" },
  ): Promise<APIKey> {
    return this.request<APIKey>(
      "POST",
      `/organizations/api_keys/${apiKeyId}`,
      update,
    );
  }

  /**
   * Deactivate all active API keys in a workspace.
   * Returns the count of keys deactivated.
   */
  async deactivateWorkspaceKeys(workspaceId: string): Promise<number> {
    let deactivated = 0;
    let afterId: string | undefined;

    // Paginate through all active keys in the workspace
    while (true) {
      const page = await this.listAPIKeys({
        workspaceId,
        status: "active",
        limit: 100,
        afterId,
      });

      for (const key of page.data) {
        await this.updateAPIKey(key.id, { status: "inactive" });
        deactivated++;
      }

      if (!page.has_more) break;
      afterId = page.last_id ?? undefined;
    }

    return deactivated;
  }
}
