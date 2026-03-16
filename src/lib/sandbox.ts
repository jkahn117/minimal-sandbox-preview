/**
 * App-specific sandbox configuration.
 *
 * The Docker image (sandbox/Dockerfile) ships with a complete Slidev
 * app pre-installed at /workspace/app — package.json, .npmrc,
 * vite.config.ts, slides.md, and node_modules are all baked in.
 *
 * At runtime we only need to:
 *   1. Write slides.md (the editable file)
 *   2. Start the Slidev dev server
 *   3. Wait for it to respond
 *
 * This keeps container startup fast with zero network dependency.
 */

import { SandboxManager } from "./sandbox-manager";

/** The directory inside the container where the Slidev app lives. */
const APP_DIR = "/workspace/app";

/**
 * Sub-path for the sandbox Vite app. Namespaces all sandbox assets to
 * avoid route collisions with the host Astro app.
 * Matches the official sandbox-sdk vite-sandbox example pattern.
 */
const VITE_BASE = "/_/";

/** The file shown in the editor pane. */
export const EDITABLE_FILE = `${APP_DIR}/slides.md`;

/** Default content for slides.md (matches sandbox/app/slides.md). */
const DEFAULT_SLIDES_MD = `---
theme: default
---

# Welcome to Slidev

Presentation slides for developers

---

# Slide 2

- Edit this file in the editor
- Save to see live updates
- Add slides with \`---\` separator

---

# Code Example

\`\`\`ts
console.log('Hello, Slidev!')
\`\`\`

---

# Learn More

[Slidev Documentation](https://sli.dev)
`;

export const sandboxManager = new SandboxManager({
  port: 3001,
  token: "slidev",
  portName: "slidev-dev",
  sleepAfter: "5m",
  basePath: VITE_BASE,

  async initialize({ sandbox, progress, host }) {
    // Write the editable file (image ships a copy, but we write it fresh
    // so the content always matches what the editor will show).
    progress("writing_files");
    await sandbox.writeFile(EDITABLE_FILE, DEFAULT_SLIDES_MD);

    // Derive the HMR client port from the host. In production this is
    // 443 (standard HTTPS). In local dev it's the Vite dev server port.
    const hostPort = host.includes(":") ? host.split(":")[1] : "443";

    // Start the Slidev dev server.
    // - Use ./node_modules/.bin/slidev (not npx) because npx has unreliable
    //   resolution for @slidev/cli's "slidev" binary.
    // - Pass slides.md as explicit entry argument.
    // - Use --remote to enable public host binding (--bind defaults to 0.0.0.0).
    // - Pipe stdin from `tail -f /dev/null` to keep the process alive. Slidev's
    //   CLI listens on stdin for keyboard shortcuts and exits immediately when
    //   stdin closes (which happens in non-TTY environments like sandbox).
    progress("starting_server");
    const proc = await sandbox.startProcess(
      "tail -f /dev/null | ./node_modules/.bin/slidev slides.md --port 3001 --remote --base " + VITE_BASE,
      {
        processId: "slidev-dev",
        cwd: APP_DIR,
        env: {
          PORT: "3001",
          NODE_ENV: "development",
          VITE_BASE: VITE_BASE,
          VITE_HMR_CLIENT_PORT: hostPort,
          // Chokidar polling is needed for reliable filesystem change
          // detection inside the container (for Vite HMR).
          CHOKIDAR_USEPOLLING: "true",
          CHOKIDAR_INTERVAL: "500",
        },
      },
    );

    // Use the SDK's waitForPort() — it polls internally using an efficient
    // mechanism and resolves as soon as port 3001 responds with HTTP 2xx/3xx.
    // This replaces our manual curl loop and is significantly faster.
    progress("waiting_for_ready");
    const waitStart = Date.now();
    try {
      await proc.waitForPort(3001, {
        mode: "http",
        path: VITE_BASE,
        status: { min: 200, max: 399 },
      });
      console.log(`[sandbox-init] waitForPort resolved in ${Date.now() - waitStart}ms`);
    } catch (err) {
      // If waitForPort fails, grab logs for diagnostics
      const logs = await proc.getLogs();
      const logOutput = [
        logs.stdout ? `stdout: ${logs.stdout.slice(0, 500)}` : "",
        logs.stderr ? `stderr: ${logs.stderr.slice(0, 500)}` : "",
      ]
        .filter(Boolean)
        .join("\n") || "no output";
      throw new Error(
        `Slidev server failed to start: ${err instanceof Error ? err.message : "unknown error"}\n${logOutput}`,
      );
    }

    // Port exposure is handled by the manager after this returns.
  },
});
