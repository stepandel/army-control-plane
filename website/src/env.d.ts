/// <reference types="astro/client" />
/// <reference types="@astrojs/cloudflare" />

type Runtime = import("@astrojs/cloudflare").Runtime<{
  API_BASE_URL: string;
}>;

declare namespace App {
  interface Locals extends Runtime {}
}
