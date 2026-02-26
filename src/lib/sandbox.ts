/**
 * App-specific sandbox configuration.
 *
 * The Docker image (sandbox/Dockerfile) ships with a complete Vue + Vite
 * app pre-installed at /workspace/app — package.json, vite.config.ts,
 * index.html, main.ts, and node_modules are all baked in.
 *
 * At runtime we only need to:
 *   1. Write App.vue (the editable file)
 *   2. Start the Vite dev server
 *   3. Wait for it to respond
 *
 * This keeps container startup fast with zero network dependency.
 */

import { SandboxManager } from "./sandbox-manager";

/** The directory inside the container where the Vue app lives. */
const APP_DIR = "/workspace/app";

/** The file shown in the editor pane. */
export const EDITABLE_FILE = `${APP_DIR}/src/App.vue`;
const VITE_CONFIG_FILE = `${APP_DIR}/vite.config.ts`;

/** Default content for App.vue (matches sandbox/app/src/App.vue). */
const DEFAULT_APP_VUE = `<script setup lang="ts">
import { ref } from "vue";

const count = ref(0);
</script>

<template>
  <div style="font-family: sans-serif; max-width: 600px; margin: 40px auto; text-align: center;">
    <h1>Hello from the Sandbox!</h1>
    <p>Edit this component in the editor and save to see HMR in action.</p>
    <button @click="count++" style="font-size: 1.2rem; padding: 8px 20px; cursor: pointer;">
      Count: {{ count }}
    </button>
  </div>
</template>
`;

const DEFAULT_VITE_CONFIG = [
  "// @ts-nocheck",
  'import { defineConfig } from "vite";',
  'import vue from "@vitejs/plugin-vue";',
  "",
  "export default defineConfig({",
  "  plugins: [",
  "    vue(),",
  "    {",
  '      name: "the-watcher",',
  "      configureServer(server) {",
  '        server.middlewares.use("/__sandbox_hmr", (req, res, next) => {',
  "          if (!req.url) {",
  "            next();",
  "            return;",
  "          }",
  "",
  '          const url = new URL(req.url, "http://localhost");',
  '          const filePath = url.searchParams.get("file");',
  "          const clientCount =",
  "            ((server.ws as unknown as { clients?: Set<unknown> }).clients?.size ??",
  "              0);",
  '          server.ws.send({ type: "full-reload" });',
  "",
  "          res.statusCode = 200;",
  '          res.setHeader("content-type", "application/json");',
  "          res.end(JSON.stringify({ ok: true, filePath, clients: clientCount }));",
  "        });",
  "      },",
  "    },",
  "  ],",
  '  cacheDir: ".sandbox-vite",',
  "  server: {",
  '    host: "0.0.0.0",',
  "    allowedHosts: true,",
  "    watch: {",
  "      usePolling: true,",
  "      interval: 500,",
  "    },",
  "  },",
  "});",
  "",
].join("\n");

export const sandboxManager = new SandboxManager({
  port: 3001,
  token: "vuehmr",
  portName: "vite-dev",
  sleepAfter: "5m",

  async initialize({ sandbox, progress }) {
    // Write the editable file (image ships a copy, but we write it fresh
    // so the content always matches what the editor will show).
    progress("writing_files");
    await sandbox.writeFile(EDITABLE_FILE, DEFAULT_APP_VUE);
    await sandbox.writeFile(VITE_CONFIG_FILE, DEFAULT_VITE_CONFIG);

    // Start the Vite dev server
    progress("starting_server");
    await sandbox.startProcess("npx vite --port 3001", {
      processId: "vite-dev",
      cwd: APP_DIR,
      env: {
        PORT: "3001",
        NODE_ENV: "development",
        // Ensure chokidar uses polling (env var fallback in case
        // the vite.config.ts watch option isn't respected).
        CHOKIDAR_USEPOLLING: "true",
        CHOKIDAR_INTERVAL: "500",
      },
    });

    // Give the process a moment to either crash or start listening
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Bail early if the process already exited
    const procStatus = await sandbox.getProcess("vite-dev");
    if (
      procStatus &&
      (procStatus.status === "completed" ||
        procStatus.status === "failed" ||
        procStatus.status === "killed" ||
        procStatus.status === "error")
    ) {
      const procLogs = await procStatus.getLogs();
      throw new Error(
        `vite dev exited immediately (exit ${procStatus.exitCode}): ${procLogs.stderr?.slice(0, 500) ?? procLogs.stdout?.slice(0, 500) ?? "no output"}`,
      );
    }

    // Poll until the server responds
    progress("waiting_for_ready");
    let isReady = false;
    for (let i = 0; i < 15; i++) {
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Check if the process crashed mid-loop
      const liveProc = await sandbox.getProcess("vite-dev");
      if (
        liveProc &&
        (liveProc.status === "completed" ||
          liveProc.status === "failed" ||
          liveProc.status === "killed" ||
          liveProc.status === "error")
      ) {
        const crashLogs = await liveProc.getLogs();
        throw new Error(
          `vite dev crashed (exit ${liveProc.exitCode}): ${crashLogs.stderr?.slice(0, 500) ?? crashLogs.stdout?.slice(0, 500) ?? "no output"}`,
        );
      }

      const health = await sandbox.exec(
        'curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/ || echo "000"',
      );
      if (health.stdout.startsWith("2") || health.stdout.startsWith("3")) {
        isReady = true;
        break;
      }
    }

    if (!isReady) {
      throw new Error("Server failed to respond within timeout");
    }

    // Port exposure is handled by the manager after this returns.
  },
});
