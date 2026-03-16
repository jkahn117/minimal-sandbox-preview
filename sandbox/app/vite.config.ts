import { defineConfig } from "vite";

export default defineConfig({
  // Namespace all assets under a sub-path to avoid collisions with the
  // host app's routes. Set via VITE_BASE env var from the worker.
  base: process.env.VITE_BASE || "/",
  server: {
    // Bind to all interfaces so the sandbox proxy can reach us.
    host: process.env.VITE_HOST ?? "0.0.0.0",
    // @ts-ignore
    port: process.env.VITE_PORT ?? 5173,
    hmr: {
      // The browser connects to the HMR WebSocket via the host's
      // external port. proxyToSandbox() in the Worker routes the WS
      // upgrade through to the container's Vite HMR server.
      clientPort: parseInt(process.env.VITE_HMR_CLIENT_PORT || "3000"),
    },
    // watch: {
    //   // Container filesystems need polling for reliable change detection.
    //   usePolling: true,
    //   interval: 500,
    // },
    // Allow the Cloudflare proxy host through
    headers: {
      "Access-Control-Allow-Origin": "*",
    },
  },
  plugins: [
    // Add cache headers for static assets served by Vite's dev server.
    // By default Vite sends no-cache for everything, but Slidev loads
    // heavy assets (Shiki grammars, fonts, framework JS) that don't
    // change between slide edits. Caching these makes iframe reloads
    // much faster.
    {
      name: "cache-static-assets",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const url = req.url || "";
          // Cache node_modules deps (Slidev framework, Vue, Shiki, UnoCSS, etc.)
          // and font/wasm/image assets aggressively. These are immutable
          // between edits — only the slide markdown content changes.
          if (
            url.includes("/node_modules/") ||
            url.includes("/@fs/") ||
            /\.(woff2?|ttf|otf|eot|wasm|png|jpg|svg|ico)(\?|$)/.test(url)
          ) {
            res.setHeader("Cache-Control", "public, max-age=3600, immutable");
          }
          next();
        });
      },
    },
  ],
});
