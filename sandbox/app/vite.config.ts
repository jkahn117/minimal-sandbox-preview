// @ts-nocheck
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [
    vue(),
    {
      name: "the-watcher",
      configureServer(server) {
        server.middlewares.use("/__sandbox_hmr", (req, res, next) => {
          if (!req.url) {
            next();
            return;
          }

          const url = new URL(req.url, "http://localhost");
          const filePath = url.searchParams.get("file");
          const clientCount =
            ((server.ws as unknown as { clients?: Set<unknown> }).clients?.size ??
              0);

          server.ws.send({ type: "full-reload" });

          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: true, filePath, clients: clientCount }));
        });
      },
    },
  ],
  cacheDir: ".sandbox-vite",
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    // Polling is essential here since you're likely in Docker/WSL
    watch: {
      usePolling: true,
      interval: 500,
    },
  },
});
