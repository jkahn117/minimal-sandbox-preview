/**
 * App-specific sandbox configuration.
 *
 * Creates a SandboxManager instance with this project's initialization
 * logic (vinext server setup). The manager handles all lifecycle
 * boilerplate: state tracking, TTL cleanup, WS broadcasts, isolate
 * eviction recovery, and PortAlreadyExposedError handling.
 *
 * Other projects using @cloudflare/sandbox would create their own
 * instance with different `initialize` logic.
 */

import { SandboxManager } from "./sandbox-manager";

export const sandboxManager = new SandboxManager({
  port: 3001,
  token: "vinext",
  portName: "vinext-server",
  sleepAfter: "5m",

  async initialize({ sandbox, progress }) {
    progress("creating_workspace");
    await sandbox.mkdir("/workspace", { recursive: true });

    progress("cloning_repo");
    await sandbox.gitCheckout("https://github.com/cloudflare/vinext", {
      targetDir: "/workspace",
    });

    // Enable shamefully-hoist so transitive deps (e.g. react-server-dom-webpack,
    // a dep of vinext) are hoisted to root node_modules. Without this, pnpm's
    // strict linking prevents Vite's dep optimizer from resolving them from the
    // example directory.
    await sandbox.exec(
      "echo 'shamefully-hoist=true' >> /workspace/.npmrc",
    );

    progress("installing_dependencies");
    const installResult = await sandbox.exec("pnpm install", {
      cwd: "/workspace",
      stream: true,
      onOutput: (_stream, data) => progress(`installing: ${data.trim()}`),
    });
    if (!installResult.success) {
      throw new Error(
        `pnpm install failed (exit ${installResult.exitCode}): ${installResult.stderr.slice(0, 500)}`,
      );
    }

    progress("building_vinext");
    const buildResult = await sandbox.exec("pnpm run build", {
      cwd: "/workspace/packages/vinext",
      stream: true,
      onOutput: (_stream, data) => progress(`building: ${data.trim()}`),
    });
    if (!buildResult.success) {
      throw new Error(
        `vinext build failed (exit ${buildResult.exitCode}): ${buildResult.stderr.slice(0, 500)}`,
      );
    }

    progress("patching_vite_config");
    await sandbox.writeFile(
      "/workspace/examples/app-router-cloudflare/vite.config.ts",
      [
        'import { defineConfig } from "vite";',
        'import vinext from "vinext";',
        'import { cloudflare } from "@cloudflare/vite-plugin";',
        "",
        "export default defineConfig({",
        "  plugins: [",
        "    vinext(),",
        "    cloudflare({",
        "      viteEnvironment: {",
        '        name: "rsc",',
        '        childEnvironments: ["ssr"],',
        "      },",
        "    }),",
        "  ],",
        "  // Use a custom cacheDir so the outer Vite dev server (running the",
        "  // Astro host app) doesn't intercept requests to the sandboxed Vite's",
        "  // pre-bundled deps. The default 'node_modules/.vite' path is recognized",
        "  // by the outer Vite and served from the host's local filesystem instead",
        "  // of being proxied to the container.",
        "  cacheDir: '.sandbox-vite',",
        "  server: {",
        "    host: '0.0.0.0',",
        "    hmr: {",
        "      clientPort: 443,",
        "      protocol: 'wss',",
        "    },",
        "    allowedHosts: ['all'],",
        "    watch: {",
        "      usePolling: true,",
        "      interval: 500,",
        "    },",
        "  },",
        "});",
        "",
      ].join("\n"),
    );

    progress("starting_server");
    await sandbox.startProcess("pnpm dev --port 3001", {
      processId: "vinext-dev",
      cwd: "/workspace/examples/app-router-cloudflare",
      env: {
        PORT: "3001",
        NODE_ENV: "development",
      },
    });

    // Give the process a moment to either crash or start listening
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Bail early if the process already exited
    const procStatus = await sandbox.getProcess("vinext-dev");
    if (
      procStatus &&
      (procStatus.status === "completed" ||
        procStatus.status === "failed" ||
        procStatus.status === "killed" ||
        procStatus.status === "error")
    ) {
      const procLogs = await procStatus.getLogs();
      throw new Error(
        `vinext dev exited immediately (exit ${procStatus.exitCode}): ${procLogs.stderr?.slice(0, 500) ?? procLogs.stdout?.slice(0, 500) ?? "no output"}`,
      );
    }

    progress("waiting_for_ready");
    let isReady = false;
    for (let i = 0; i < 15; i++) {
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Check if the process crashed mid-loop
      const liveProc = await sandbox.getProcess("vinext-dev");
      if (
        liveProc &&
        (liveProc.status === "completed" ||
          liveProc.status === "failed" ||
          liveProc.status === "killed" ||
          liveProc.status === "error")
      ) {
        const crashLogs = await liveProc.getLogs();
        throw new Error(
          `vinext dev crashed (exit ${liveProc.exitCode}): ${crashLogs.stderr?.slice(0, 500) ?? crashLogs.stdout?.slice(0, 500) ?? "no output"}`,
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
