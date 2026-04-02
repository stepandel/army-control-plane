/**
 * Fly.io Machines API client.
 * Supports both shared-app and app-per-tenant architectures.
 * Docs: https://fly.io/docs/machines/api/
 */

const FLY_API_BASE = "https://api.machines.dev/v1";
const FLY_GRAPHQL_URL = "https://api.fly.io/graphql";
const REGIONS = ["ewr", "ord", "iad"];
const DEFAULT_REGION = REGIONS[0];
const VOLUME_NAME = "anton_state";
const VOLUME_PATH = "/workspace";

const MACHINE_GUEST: GuestConfig = {
  cpu_kind: "shared",
  cpus: 2,
  memory_mb: 1024,
};

/** Machine sizing configuration. */
export interface GuestConfig {
  cpu_kind: string;
  cpus: number;
  memory_mb: number;
}

interface ServiceConfig {
  protocol: string;
  internal_port: number;
  ports: Array<{
    port: number;
    handlers: string[];
    force_https?: boolean;
  }>;
  concurrency?: {
    type: string;
    soft_limit: number;
    hard_limit: number;
  };
  autostart?: boolean;
  autostop?: string;
  min_machines_running?: number;
}

interface MachineConfig {
  image: string;
  env?: Record<string, string>;
  guest: GuestConfig;
  mounts?: Array<{
    volume: string;
    name: string;
    path: string;
  }>;
  services?: ServiceConfig[];
  metrics?: {
    port: number;
    path: string;
  };
}

interface VolumeResponse {
  id: string;
  name: string;
  region: string;
  size_gb: number;
  state: string;
}

interface CreateMachineRequest {
  name: string;
  region: string;
  config: MachineConfig;
}

export interface MachineResponse {
  id: string;
  name: string;
  state: string;
  region: string;
  instance_id: string;
  private_ip: string;
  config: MachineConfig;
}

export class FlyClient {
  private token: string;
  private appName: string;
  private image: string;

  constructor(token: string, appName: string, image?: string) {
    this.token = token;
    this.appName = appName;
    this.image = image ?? `registry.fly.io/${appName}:latest`;
  }

  /** App-scoped request: all paths are prefixed with /apps/{appName}. */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
    };
    if (body) init.body = JSON.stringify(body);

    const resp = await fetch(`${FLY_API_BASE}/apps/${this.appName}${path}`, init);

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Fly API ${method} ${path} failed (${resp.status}): ${text}`);
    }

    if (resp.status === 204) return undefined as T;
    return resp.json() as Promise<T>;
  }

  /** Global request: path is used as-is against the Fly API base (no app prefix). */
  private async requestGlobal<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
    };
    if (body) init.body = JSON.stringify(body);

    const resp = await fetch(`${FLY_API_BASE}${path}`, init);

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Fly API ${method} ${path} failed (${resp.status}): ${text}`);
    }

    if (resp.status === 202 || resp.status === 204) return undefined as T;
    return resp.json() as Promise<T>;
  }

  /** Execute a GraphQL query/mutation against the Fly.io GraphQL API. */
  private async graphqlRequest<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const resp = await fetch(FLY_GRAPHQL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Fly GraphQL API failed (${resp.status}): ${text}`);
    }

    const result = (await resp.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (result.errors?.length) {
      throw new Error(`Fly GraphQL error: ${result.errors.map((e) => e.message).join(", ")}`);
    }

    return result.data as T;
  }

  // ── App lifecycle methods ──────────────────────────────────────

  /** Create a new Fly app in the given organization. */
  async createApp(appName: string, orgSlug: string): Promise<{ id: string }> {
    return this.requestGlobal<{ id: string }>("POST", "/apps", {
      app_name: appName,
      org_slug: orgSlug,
    });
  }

  /** Delete a Fly app and all its machines, volumes, and IPs. */
  async deleteApp(appName: string): Promise<void> {
    await this.requestGlobal<void>("DELETE", `/apps/${appName}?force=true`);
  }

  /** Allocate a shared IPv4 address for an app (required for .fly.dev routing). */
  async allocateSharedIp(appName: string): Promise<string> {
    const mutation = `
      mutation($input: AllocateIPAddressInput!) {
        allocateIpAddress(input: $input) {
          app {
            sharedIpAddress
          }
        }
      }
    `;
    const data = await this.graphqlRequest<{
      allocateIpAddress: { app: { sharedIpAddress: string } };
    }>(mutation, {
      input: { appId: appName, type: "shared_v4", region: "" },
    });
    return data.allocateIpAddress.app.sharedIpAddress;
  }

  /** Create a Tigris storage bucket attached to a Fly app. Credentials are auto-set as app secrets. */
  async createTigrisBucket(appName: string, orgSlug: string, bucketName: string): Promise<void> {
    const mutation = `
      mutation($input: CreateAddOnInput!) {
        createAddOn(input: $input) {
          addOn { name }
        }
      }
    `;
    await this.graphqlRequest(mutation, {
      input: {
        type: "tigris",
        organizationId: orgSlug,
        name: bucketName,
        appId: appName,
        options: { public: false },
      },
    });
  }

  /** Allocate a dedicated IPv6 address for an app. */
  async allocateIpV6(appName: string): Promise<{ id: string; address: string; type: string }> {
    const mutation = `
      mutation($input: AllocateIPAddressInput!) {
        allocateIpAddress(input: $input) {
          ipAddress {
            id
            address
            type
          }
        }
      }
    `;
    const data = await this.graphqlRequest<{
      allocateIpAddress: { ipAddress: { id: string; address: string; type: string } };
    }>(mutation, {
      input: { appId: appName, type: "v6", region: "" },
    });
    return data.allocateIpAddress.ipAddress;
  }

  // ── Volume methods ─────────────────────────────────────────────

  /** Create a persistent volume. */
  async createVolume(
    name: string,
    sizeGb: number,
    region = DEFAULT_REGION,
  ): Promise<VolumeResponse> {
    return this.request<VolumeResponse>("POST", "/volumes", {
      name,
      size_gb: sizeGb,
      region,
    });
  }

  /** Delete a volume. */
  async deleteVolume(volumeId: string): Promise<void> {
    await this.request<void>("DELETE", `/volumes/${volumeId}`);
  }

  // ── Machine methods ────────────────────────────────────────────

  private buildServiceConfig(): ServiceConfig[] {
    return [
      {
        protocol: "tcp",
        internal_port: 3000,
        ports: [
          { port: 80, handlers: ["http"], force_https: true },
          { port: 443, handlers: ["tls", "http"] },
        ],
        concurrency: {
          type: "requests",
          soft_limit: 100,
          hard_limit: 150,
        },
        autostart: true,
        autostop: "stop",
        min_machines_running: 1,
      },
    ];
  }

  /** Create and start a machine inside the app. */
  async createMachine(
    machineName: string,
    env: Record<string, string>,
    volumeId?: string,
    region = DEFAULT_REGION,
    guest?: GuestConfig,
  ): Promise<MachineResponse> {
    const body: CreateMachineRequest = {
      name: machineName,
      region,
      config: {
        image: this.image,
        env,
        guest: guest ?? MACHINE_GUEST,
        ...(volumeId
          ? { mounts: [{ volume: volumeId, name: VOLUME_NAME, path: VOLUME_PATH }] }
          : {}),
        services: this.buildServiceConfig(),
        metrics: { port: 3000, path: "/metrics" },
      },
    };

    return this.request<MachineResponse>("POST", "/machines", body);
  }

  /** Update a machine's config (env vars, image, etc.). Reboots if running. */
  async updateMachine(
    machineId: string,
    env: Record<string, string>,
    volumeId?: string,
    guest?: GuestConfig,
  ): Promise<MachineResponse> {
    return this.request<MachineResponse>("POST", `/machines/${machineId}`, {
      config: {
        image: this.image,
        env,
        guest: guest ?? MACHINE_GUEST,
        ...(volumeId
          ? { mounts: [{ volume: volumeId, name: VOLUME_NAME, path: VOLUME_PATH }] }
          : {}),
        services: this.buildServiceConfig(),
        metrics: { port: 3000, path: "/metrics" },
      },
    });
  }

  /**
   * Resize a running machine by updating its guest config.
   * Fetches the current machine config, replaces the guest, and updates.
   */
  async resizeMachine(machineId: string, guest: GuestConfig): Promise<MachineResponse> {
    const current = await this.request<MachineResponse>("GET", `/machines/${machineId}`);
    const updatedConfig = { ...current.config, guest };
    return this.request<MachineResponse>("POST", `/machines/${machineId}`, {
      config: updatedConfig,
    });
  }

  /**
   * Deploy a new image to a machine. Fetches current config and swaps the image,
   * preserving all other settings (env, mounts, services, guest).
   */
  async deployImage(machineId: string, image: string): Promise<MachineResponse> {
    const current = await this.request<MachineResponse>("GET", `/machines/${machineId}`);
    const updatedConfig = { ...current.config, image };
    return this.request<MachineResponse>("POST", `/machines/${machineId}`, {
      config: updatedConfig,
    });
  }

  /**
   * Create a volume + machine together, retrying across regions on capacity errors.
   * Cleans up the volume if machine creation fails in a region before trying the next.
   */
  async createMachineWithVolume(
    machineName: string,
    env: Record<string, string>,
    volumeName: string,
    volumeSizeGb: number,
    guest?: GuestConfig,
  ): Promise<{ machine: MachineResponse; volume: VolumeResponse }> {
    const errors: string[] = [];

    for (const region of REGIONS) {
      let volume: VolumeResponse | undefined;
      try {
        volume = await this.createVolume(volumeName, volumeSizeGb, region);
        const machine = await this.createMachine(machineName, env, volume.id, region, guest);
        return { machine, volume };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${region}: ${msg}`);
        // Clean up orphaned volume before trying next region
        if (volume) {
          try { await this.deleteVolume(volume.id); } catch { /* best effort */ }
        }
        // Only retry on capacity errors (409)
        if (!msg.includes("(409)")) throw err;
      }
    }

    throw new Error(`Machine creation failed in all regions:\n${errors.join("\n")}`);
  }

  /** Stop a running machine. */
  async stopMachine(machineId: string): Promise<void> {
    await this.request<void>("POST", `/machines/${machineId}/stop`);
  }

  /** Destroy a machine permanently. */
  async destroyMachine(machineId: string): Promise<void> {
    await this.request<void>("DELETE", `/machines/${machineId}?force=true`);
  }
}
