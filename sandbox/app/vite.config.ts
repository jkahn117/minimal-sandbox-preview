import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  cacheDir: ".sandbox-vite",
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    hmr: {
      // In production, the browser loads the preview via the exposed port
      // subdomain on standard HTTPS (443). In local dev (Phase 2), this
      // will be set to the host Vite server port via env var.
      clientPort: parseInt(process.env.VITE_HMR_CLIENT_PORT || "443"),
    },
    watch: {
      usePolling: true,
      interval: 500,
    },
  },
});
