/**
 * Shared sandbox state and initialization logic.
 * Used by the Astro action (startSandbox) and the WebSocket API route (/api/ws).
 */

// Module-level state persists within a Worker isolate
let isInitialized = false;
let isInitializing = false;
let previewUrl: string | null = null;
let currentStep = "";
let initError: string | null = null;

const connections = new Set<WebSocket>();

export function getConnections() {
  return connections;
}

export function getState() {
  return { isInitialized, previewUrl, currentStep, initError };
}

function broadcast(message: Record<string, unknown>) {
  const data = JSON.stringify(message);
  connections.forEach((ws) => {
    try {
      ws.send(data);
    } catch {
      connections.delete(ws);
    }
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function initializeSandbox(
  host: string,
  sandboxBinding: DurableObjectNamespace<any>,
) {
  try {
    console.log("[sandbox] Starting initialization...");

    const { getSandbox } = await import("@cloudflare/sandbox");
    const sandbox = getSandbox(sandboxBinding, "minimal-example-sandbox", {
      normalizeId: true,
    });

    broadcast({ type: "progress", step: "creating_workspace" });
    currentStep = "creating_workspace";
    await sandbox.mkdir("/workspace", { recursive: true });

    broadcast({ type: "progress", step: "writing_files" });
    currentStep = "writing_files";
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
    // Running npm install at runtime is redundant and reports "Success: false".

    broadcast({ type: "progress", step: "starting_server" });
    currentStep = "starting_server";
    await sandbox.startProcess("node server.js", {
      cwd: "/workspace",
      env: {
        PORT: "3001",
        NODE_ENV: "production",
      },
    });

    broadcast({ type: "progress", step: "waiting_for_ready" });
    currentStep = "waiting_for_ready";
    let isReady = false;
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
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

    broadcast({ type: "progress", step: "exposing_port" });
    currentStep = "exposing_port";

    let exposedUrl: string;
    try {
      const exposed = await sandbox.exposePort(3001, {
        hostname: host,
        name: "express-server",
        token: "express",
      });
      exposedUrl = exposed.url;
    } catch (exposeErr: unknown) {
      // Port persists across deploys — if already exposed, retrieve the
      // existing preview URL via getHost()
      const msg =
        exposeErr instanceof Error ? exposeErr.message : String(exposeErr);
      if (msg.includes("PortAlreadyExposedError")) {
        console.log("[sandbox] Port already exposed, retrieving existing URL");
        const existingHost = await sandbox.getHost(3001);
        exposedUrl = `https://${existingHost}`;
      } else {
        throw exposeErr;
      }
    }

    previewUrl = exposedUrl;
    isInitialized = true;
    isInitializing = false;
    currentStep = "ready";

    broadcast({
      type: "ready",
      previewUrl,
    });

    console.log("[sandbox] Initialized successfully, preview:", previewUrl);
  } catch (error) {
    initError = error instanceof Error ? error.message : "Unknown error";
    isInitializing = false;
    currentStep = "";
    broadcast({
      type: "error",
      message: initError,
    });
    console.error("[sandbox] Failed to initialize:", error);
  }
}

/**
 * Start sandbox initialization if not already done.
 * Returns current status for the client.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function startSandbox(
  host: string,
  sandboxBinding: DurableObjectNamespace<any>,
  waitUntil?: (promise: Promise<unknown>) => void,
) {
  if (isInitialized && previewUrl) {
    return {
      status: "ready" as const,
      previewUrl,
      wsEndpoint: "/api/ws",
    };
  }

  // Already initializing — don't start a second concurrent run
  if (isInitializing) {
    return {
      status: "initializing" as const,
      wsEndpoint: "/api/ws",
      message: "Initialization already in progress",
    };
  }

  // Reset on previous error
  if (initError) {
    initError = null;
    isInitialized = false;
    previewUrl = null;
  }

  // Mark as initializing to prevent concurrent runs
  isInitializing = true;

  // Fire off initialization, kept alive via waitUntil
  const initPromise = initializeSandbox(host, sandboxBinding);
  if (waitUntil) {
    waitUntil(initPromise);
  }

  return {
    status: "initializing" as const,
    wsEndpoint: "/api/ws",
    message: "Connect to WebSocket for progress updates",
  };
}
