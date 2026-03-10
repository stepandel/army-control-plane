/**
 * Fly.io Machines API client.
 * All machines live under a single shared Fly app (e.g. "army-agents").
 * Docs: https://fly.io/docs/machines/api/
 */

const FLY_API_BASE = "https://api.machines.dev/v1";
const DEFAULT_REGION = "ord";

interface MachineConfig {
  image: string;
  env?: Record<string, string>;
  guest: {
    cpu_kind: string;
    cpus: number;
    memory_mb: number;
  };
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

  /** Create and start a machine inside the app. */
  async createMachine(
    machineName: string,
    env: Record<string, string>,
    region = DEFAULT_REGION,
  ): Promise<MachineResponse> {
    const body: CreateMachineRequest = {
      name: machineName,
      region,
      config: {
        image: this.image,
        env,
        guest: {
          cpu_kind: "shared",
          cpus: 1,
          memory_mb: 512,
        },
        services: [
          {
            protocol: "tcp",
            internal_port: 8080,
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
      },
    };

    return this.request<MachineResponse>("POST", "/machines", body);
  }

  /** Update a machine's config (env vars, image, etc.). Reboots if running. */
  async updateMachine(
    machineId: string,
    env: Record<string, string>,
  ): Promise<MachineResponse> {
    return this.request<MachineResponse>("POST", `/machines/${machineId}`, {
      config: {
        image: this.image,
        env,
        guest: {
          cpu_kind: "shared",
          cpus: 1,
          memory_mb: 512,
        },
        services: [
          {
            protocol: "tcp",
            internal_port: 8080,
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
      },
    });
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
