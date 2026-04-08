import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

export default defineConfig({
  site: "https://agent-vera.com",
  output: "static",
  adapter: cloudflare(),
  build: {
    assets: "_assets",
  },
  compressHTML: true,
});
