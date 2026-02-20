/**
 * App-specific sandbox configuration.
 *
 * Creates a SandboxManager instance with this project's initialization
 * logic (Express server setup). The manager handles all lifecycle
 * boilerplate: state tracking, TTL cleanup, WS broadcasts, isolate
 * eviction recovery, and PortAlreadyExposedError handling.
 *
 * Other projects using @cloudflare/sandbox would create their own
 * instance with different `initialize` logic.
 */

import { SandboxManager } from "./sandbox-manager";

export const sandboxManager = new SandboxManager({
  port: 3001,
  token: "express",
  portName: "express-server",
  sleepAfter: "5m",

  async initialize({ sandbox, progress }) {
    progress("creating_workspace");
    await sandbox.mkdir("/workspace", { recursive: true });

    progress("writing_files");
    await sandbox.writeFile(
      "/workspace/package.json",
      JSON.stringify(
        {
          name: "sandbox-express-app",
          version: "1.0.0",
          type: "module",
          dependencies: { express: "^4.18.2" },
        },
        null,
        2,
      ),
    );

    await sandbox.writeFile(
      "/workspace/server.js",
      `
import express from 'express';

const app = express();
const PORT = process.env.PORT || 3001;

app.get('/', (req, res) => {
  res.json({
    message: 'Hello from Express in Cloudflare Sandbox!',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    port: PORT
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('Express server running on port ' + PORT);
});
      `.trim(),
    );

    // Skip npm install — the Dockerfile pre-installs deps via pnpm.

    progress("starting_server");
    await sandbox.startProcess("node server.js", {
      cwd: "/workspace",
      env: {
        PORT: "3001",
        NODE_ENV: "production",
      },
    });

    progress("waiting_for_ready");
    let isReady = false;
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const health = await sandbox.exec(
        'curl -s http://localhost:3001/health || echo "not ready"',
      );
      if (health.stdout.includes("ok")) {
        isReady = true;
        break;
      }
    }

    if (!isReady) {
      throw new Error("Server failed to start within timeout");
    }

    // Port exposure is handled by the manager after this returns.
  },
});
