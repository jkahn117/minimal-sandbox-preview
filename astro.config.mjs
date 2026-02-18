import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

export default defineConfig({
  output: "server",
  adapter: cloudflare({
    runtime: {
      mode: "local",
    },
    platformProxy: {
      enabled: true,
    },
  }),
  vite: {
    build: {
      rollupOptions: {
        input: {
          worker: "./src/worker/index.ts",
        },
      },
    },
  },
});
