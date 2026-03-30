import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://agent-army.ai",
  output: "static",
  build: {
    assets: "_assets",
  },
  compressHTML: true,
});
