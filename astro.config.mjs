import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

export default defineConfig({
  output: "server",
  adapter: cloudflare(),
  vite: {
    // Use custom appType to avoid Vite HTML handling conflicts with
    // Cloudflare asset serving (matches official sandbox-sdk example).
    appType: "custom",
    build: {
      minify: false,
    },
    server: {
      hmr: {
        // Host HMR on a separate port to avoid conflicts with the
        // sandbox's HMR WebSocket routed through proxyToSandbox().
        port: 24679,
      },
    },
  },
});
