/// <reference types="astro/client" />
/// <reference types="@astrojs/cloudflare" />

type Runtime = import("@astrojs/cloudflare").Runtime<{
  API_BASE_URL: string;
  SHOW_BYOK: string;
  CONTROL_PLANE: { fetch: typeof fetch };
}>;

declare namespace App {
  interface Locals extends Runtime {}
}
