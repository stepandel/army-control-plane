/**
 * Fly.io Machines API client.
 * Docs: https://fly.io/docs/machines/api/
 */

const FLY_API_BASE = "https://api.machines.dev/v1";
const DEFAULT_REGION = "ord";
const MACHINE_IMAGE = "registry.fly.io/pi-agent-images:latest";

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

interface MachineResponse {
  id: string;
  name: string;
  state: string;
  region: string;
  instance_id: string;
  private_ip: string;
  config: MachineConfig;
}

interface FlyAppResponse {
  id: string;
  name: string;
  status: string;
  organization: { slug: string };
}

export class FlyClient {
  private token: string;

  constructor(token: string) {
    this.token = token;
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

    const resp = await fetch(`${FLY_API_BASE}${path}`, init);

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Fly API ${method} ${path} failed (${resp.status}): ${text}`);
    }

    if (resp.status === 204) return undefined as T;
    return resp.json() as Promise<T>;
  }

  /** Create a new Fly app to host the machine. */
  async createApp(appName: string, orgSlug: string): Promise<FlyAppResponse> {
    return this.request<FlyAppResponse>("POST", "/apps", {
      app_name: appName,
      org_slug: orgSlug,
    });
  }

  /** Create and start a machine inside an existing app. */
  async createMachine(
    appName: string,
    machineName: string,
    env: Record<string, string>,
    region = DEFAULT_REGION,
  ): Promise<MachineResponse> {
    const body: CreateMachineRequest = {
      name: machineName,
      region,
      config: {
        image: MACHINE_IMAGE,
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

    return this.request<MachineResponse>("POST", `/apps/${appName}/machines`, body);
  }

  /** Update a machine's config (env vars, image, etc.). Reboots if running. */
  async updateMachine(
    appName: string,
    machineId: string,
    env: Record<string, string>,
  ): Promise<MachineResponse> {
    return this.request<MachineResponse>("POST", `/apps/${appName}/machines/${machineId}`, {
      config: {
        image: MACHINE_IMAGE,
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
  async stopMachine(appName: string, machineId: string): Promise<void> {
    await this.request<void>("POST", `/apps/${appName}/machines/${machineId}/stop`);
  }

  /** Destroy a machine permanently. */
  async destroyMachine(appName: string, machineId: string): Promise<void> {
    await this.request<void>("DELETE", `/apps/${appName}/machines/${machineId}?force=true`);
  }

  /** Delete an entire Fly app and all its machines. */
  async deleteApp(appName: string): Promise<void> {
    await this.request<void>("DELETE", `/apps/${appName}`);
  }
}
