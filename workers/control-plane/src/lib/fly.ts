/**
 * Fly.io Machines API client.
 * All machines live under a single shared Fly app (e.g. "army-agents").
 * Docs: https://fly.io/docs/machines/api/
 */

const FLY_API_BASE = "https://api.machines.dev/v1";
const REGIONS = ["ewr", "ord", "iad"];
const DEFAULT_REGION = REGIONS[0];
const VOLUME_NAME = "anton_state";
const VOLUME_PATH = "/workspace";

const MACHINE_GUEST = {
  cpu_kind: "shared",
  cpus: 2,
  memory_mb: 1024,
} as const;

interface MachineConfig {
  image: string;
  env?: Record<string, string>;
  guest: {
    cpu_kind: string;
    cpus: number;
    memory_mb: number;
  };
  mounts?: Array<{
    volume: string;
    name: string;
    path: string;
  }>;
  services?: Array<{
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
  }>;
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

  constructor(token: string, appName: string) {
    this.token = token;
    this.appName = appName;
    this.image = `registry.fly.io/${appName}:latest`;
  }

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

  /** Create and start a machine inside the app. */
  async createMachine(
    machineName: string,
    env: Record<string, string>,
    volumeId?: string,
    region = DEFAULT_REGION,
  ): Promise<MachineResponse> {
    const body: CreateMachineRequest = {
      name: machineName,
      region,
      config: {
        image: this.image,
        env,
        guest: MACHINE_GUEST,
        ...(volumeId
          ? { mounts: [{ volume: volumeId, name: VOLUME_NAME, path: VOLUME_PATH }] }
          : {}),
        services: [
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
          },
        ],
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
  ): Promise<MachineResponse> {
    return this.request<MachineResponse>("POST", `/machines/${machineId}`, {
      config: {
        image: this.image,
        env,
        guest: MACHINE_GUEST,
        ...(volumeId
          ? { mounts: [{ volume: volumeId, name: VOLUME_NAME, path: VOLUME_PATH }] }
          : {}),
        services: [
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
          },
        ],
        metrics: { port: 3000, path: "/metrics" },
      },
    });
  }

  /** Delete a volume. */
  async deleteVolume(volumeId: string): Promise<void> {
    await this.request<void>("DELETE", `/volumes/${volumeId}`);
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
  ): Promise<{ machine: MachineResponse; volume: VolumeResponse }> {
    const errors: string[] = [];

    for (const region of REGIONS) {
      let volume: VolumeResponse | undefined;
      try {
        volume = await this.createVolume(volumeName, volumeSizeGb, region);
        const machine = await this.createMachine(machineName, env, volume.id, region);
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
