/**
 * Shared sandbox state and initialization logic.
 * Each page view gets a unique sandboxId → unique Durable Object → unique container.
 *
 * ## Container lifecycle and TTL cleanup
 *
 * Problem: Each page view creates a unique sandbox container. With
 * max_instances limited (currently 5), abandoned containers from previous
 * page views block new ones. The in-memory Map also grows unboundedly.
 *
 * Solution: Two-layer defense (see decision 20 in _plan/4. decisions.md):
 *
 * 1. **JS-level TTL** (SANDBOX_TTL_MS = 5 min) — A setTimeout in the
 *    Worker isolate that calls sandbox.destroy() to explicitly kill the
 *    container, free the instance slot, and remove the Map entry. Reset
 *    on every status check (touchSandbox), so active users keep their
 *    container alive.
 *
 * 2. **SDK-level sleepAfter** (SLEEP_AFTER = "5m") — Passed to
 *    getSandbox() as a safety net. If the Worker isolate is evicted
 *    before the JS timer fires (isolates can be killed after ~30s of no
 *    requests), the container still auto-sleeps after 5 min of inactivity
 *    on its own.
 *
 * Caveat: setTimeout lives in isolate memory. If the isolate is evicted,
 * the timer is lost. That's why sleepAfter exists as a belt-and-suspenders
 * fallback. A more robust solution would use DO alarms, but the Sandbox
 * SDK provides its own DO class so we can't add custom alarm handlers.
 *
 * ## WebSocket broadcasts
 *
 * During initialization (which runs inside waitUntil), progress updates
 * are broadcast to connected WebSocket clients via the `connections` Set.
 * These broadcasts may not reliably reach clients (see decision 9/19),
 * which is why the client has a deferred polling fallback.
 */

/** How long a sandbox lives after last activity before auto-destroy (5 min) */
const SANDBOX_TTL_MS = 5 * 60 * 1000;

/**
 * Container auto-sleeps after this duration of inactivity at the DO level.
 * Aligned with SANDBOX_TTL_MS so the container stays alive as long as the
 * in-memory state exists. This is a safety net — the JS-level TTL is the
 * primary cleanup mechanism. sleepAfter covers the case where the isolate
 * is evicted before the JS timer fires.
 *
 * Note: "inactivity" means no requests to the Durable Object — our
 * touchSandbox() only resets the JS timer, it doesn't ping the container.
 * The preview iframe loading counts as container activity (requests hit
 * the DO via proxyToSandbox), which resets this timer naturally.
 */
const SLEEP_AFTER = "5m";

interface SandboxState {
  isInitialized: boolean;
  isInitializing: boolean;
  previewUrl: string | null;
  currentStep: string;
  initError: string | null;
  connections: Set<WebSocket>;
  lastActivity: number;
  destroyTimer: ReturnType<typeof setTimeout> | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sandboxBinding: DurableObjectNamespace<any> | null;
}

/**
 * In-memory state keyed by sandboxId. Each page view gets its own entry.
 * Lives only as long as the Worker isolate — entries are lost if the
 * isolate is evicted, but the container itself persists (managed by
 * the Sandbox SDK's Durable Object).
 */
const sandboxes = new Map<string, SandboxState>();

function getOrCreateState(sandboxId: string): SandboxState {
  let state = sandboxes.get(sandboxId);
  if (!state) {
    state = {
      isInitialized: false,
      isInitializing: false,
      previewUrl: null,
      currentStep: "",
      initError: null,
      connections: new Set(),
      lastActivity: Date.now(),
      destroyTimer: null,
      sandboxBinding: null,
    };
    sandboxes.set(sandboxId, state);
  }
  return state;
}

/**
 * Reset the TTL destroy timer. Called on every client interaction
 * (startSandbox status checks from polling or initial call) to keep
 * active sandboxes alive as long as someone is viewing the page.
 */
function touchSandbox(sandboxId: string, state: SandboxState) {
  state.lastActivity = Date.now();
  scheduleDestroy(sandboxId, state);
}

/**
 * Schedule (or reschedule) the TTL destroy timer.
 * Clears any existing timer before setting a new one, so each
 * touchSandbox() call effectively extends the deadline.
 */
function scheduleDestroy(sandboxId: string, state: SandboxState) {
  if (state.destroyTimer) {
    clearTimeout(state.destroyTimer);
  }
  state.destroyTimer = setTimeout(
    () => destroySandbox(sandboxId),
    SANDBOX_TTL_MS,
  );
}

/**
 * Destroy the sandbox container and clean up all in-memory state.
 * Calls sandbox.destroy() which terminates the container, kills all
 * processes, deletes files, and frees the instance slot (counting
 * against max_instances).
 */
async function destroySandbox(sandboxId: string) {
  const state = sandboxes.get(sandboxId);
  if (!state) return;

  console.log(`[sandbox:${sandboxId}] TTL expired, destroying container...`);

  // Close all WS connections
  state.connections.forEach((ws) => {
    try { ws.close(); } catch { /* ignore */ }
  });

  // Destroy the actual container
  if (state.sandboxBinding) {
    try {
      const { getSandbox } = await import("@cloudflare/sandbox");
      const sandbox = getSandbox(state.sandboxBinding, sandboxId, {
        normalizeId: true,
      });
      await sandbox.destroy();
      console.log(`[sandbox:${sandboxId}] Container destroyed successfully`);
    } catch (err) {
      console.warn(`[sandbox:${sandboxId}] Error destroying container:`, err);
    }
  }

  // Clean up in-memory state
  if (state.destroyTimer) clearTimeout(state.destroyTimer);
  sandboxes.delete(sandboxId);
}

export function getConnections(sandboxId: string): Set<WebSocket> {
  return getOrCreateState(sandboxId).connections;
}

export function getState(sandboxId: string) {
  const state = getOrCreateState(sandboxId);
  return {
    isInitialized: state.isInitialized,
    previewUrl: state.previewUrl,
    currentStep: state.currentStep,
    initError: state.initError,
  };
}

function broadcast(state: SandboxState, message: Record<string, unknown>) {
  const data = JSON.stringify(message);
  state.connections.forEach((ws) => {
    try {
      ws.send(data);
    } catch {
      state.connections.delete(ws);
    }
  });
}

/** Transition a sandbox to the "ready" state, broadcast to clients, and start TTL */
function markReady(sandboxId: string, state: SandboxState, previewUrl: string) {
  state.previewUrl = previewUrl;
  state.isInitialized = true;
  state.isInitializing = false;
  state.currentStep = "ready";
  touchSandbox(sandboxId, state);
  broadcast(state, { type: "ready", previewUrl });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function initializeSandbox(
  sandboxId: string,
  host: string,
  sandboxBinding: DurableObjectNamespace<any>,
) {
  const state = getOrCreateState(sandboxId);
  state.sandboxBinding = sandboxBinding;

  try {
    console.log(`[sandbox:${sandboxId}] Starting initialization...`);

    const { getSandbox } = await import("@cloudflare/sandbox");
    const sandbox = getSandbox(sandboxBinding, sandboxId, {
      normalizeId: true,
      sleepAfter: SLEEP_AFTER,
    });

    // --- Recovery check: if the container already has port 3001 exposed
    // (e.g. from a previous init that succeeded before the isolate was
    // evicted), skip the full init and go straight to "ready".
    // This prevents PortAlreadyExposedError loops and avoids redundant
    // mkdir/writeFile/startProcess calls on an already-running container.
    try {
      const exposedResult = await sandbox.getExposedPorts();
      console.log(
        `[sandbox:${sandboxId}] getExposedPorts result:`,
        JSON.stringify(exposedResult),
      );
      // SDK may return { ports: [...] } or the array directly — handle both
      const ports = Array.isArray(exposedResult)
        ? exposedResult
        : Array.isArray(exposedResult?.ports)
          ? exposedResult.ports
          : [];
      const existing = ports.find(
        (p: { port?: number }) => p.port === 3001,
      );
      if (existing) {
        // Reconstruct the preview URL from the known pattern
        const previewUrl = `https://3001-${sandboxId}-express.${host}/`;
        console.log(
          `[sandbox:${sandboxId}] Container already has port 3001 exposed, reusing:`,
          previewUrl,
        );
        markReady(sandboxId, state, previewUrl);
        return;
      }
    } catch (err) {
      // getExposedPorts may fail if the container isn't running yet — that's
      // fine, proceed with full initialization
      console.log(
        `[sandbox:${sandboxId}] Could not check exposed ports (container may be new):`,
        err instanceof Error ? err.message : err,
      );
    }

    broadcast(state, { type: "progress", step: "creating_workspace" });
    state.currentStep = "creating_workspace";
    await sandbox.mkdir("/workspace", { recursive: true });

    broadcast(state, { type: "progress", step: "writing_files" });
    state.currentStep = "writing_files";
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

    broadcast(state, { type: "progress", step: "starting_server" });
    state.currentStep = "starting_server";
    await sandbox.startProcess("node server.js", {
      cwd: "/workspace",
      env: {
        PORT: "3001",
        NODE_ENV: "production",
      },
    });

    broadcast(state, { type: "progress", step: "waiting_for_ready" });
    state.currentStep = "waiting_for_ready";
    let isReady = false;
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const health = await sandbox.exec(
        'curl -s http://localhost:3001/health || echo "not ready"',
      );
      console.log(
        `[sandbox:${sandboxId}] health check attempt ${i + 1}:`,
        health.stdout,
      );
      if (health.stdout.includes("ok")) {
        isReady = true;
        break;
      }
    }

    if (!isReady) {
      throw new Error("Server failed to start within timeout");
    }

    // Expose port 3001 — catch PortAlreadyExposedError in case of a
    // race condition where another request exposed it between our
    // getExposedPorts check and now.
    broadcast(state, { type: "progress", step: "exposing_port" });
    state.currentStep = "exposing_port";
    let previewUrl: string;
    try {
      const exposed = await sandbox.exposePort(3001, {
        hostname: host,
        name: "express-server",
        token: "express",
      });
      previewUrl = exposed.url;
    } catch (exposeErr) {
      const msg = exposeErr instanceof Error ? exposeErr.message : "";
      if (msg.includes("PortAlreadyExposedError") || msg.includes("already exposed")) {
        // Port was exposed by a concurrent init — construct URL from pattern
        previewUrl = `https://3001-${sandboxId}-express.${host}/`;
        console.log(
          `[sandbox:${sandboxId}] Port already exposed, reusing URL:`,
          previewUrl,
        );
      } else {
        throw exposeErr;
      }
    }

    markReady(sandboxId, state, previewUrl);

    console.log(
      `[sandbox:${sandboxId}] Initialized successfully, preview:`,
      previewUrl,
      `(TTL: ${SANDBOX_TTL_MS / 1000}s)`,
    );
  } catch (error) {
    state.initError = error instanceof Error ? error.message : "Unknown error";
    state.isInitializing = false;
    state.currentStep = "";
    broadcast(state, {
      type: "error",
      message: state.initError,
    });
    console.error(`[sandbox:${sandboxId}] Failed to initialize:`, error);
  }
}

/**
 * Start sandbox initialization if not already done.
 * Returns current status for the client.
 *
 * Called by the Astro action (`actions.startSandbox`) which is invoked:
 * 1. Once on page load (initial trigger)
 * 2. Periodically by the client's deferred polling fallback (if WS is silent)
 *
 * This function is idempotent:
 * - If already initialized → returns "ready" + preview URL, resets TTL
 * - If currently initializing → returns "initializing" (no-op)
 * - If previous error → resets error state, retries initialization
 * - Otherwise → kicks off initializeSandbox() inside waitUntil()
 *
 * The actual init runs as a fire-and-forget promise kept alive by
 * waitUntil(). Without waitUntil, workerd would kill the async work
 * when the HTTP response is sent (init takes 30-40s).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function startSandbox(
  sandboxId: string,
  host: string,
  sandboxBinding: DurableObjectNamespace<any>,
  waitUntil?: (promise: Promise<unknown>) => void,
) {
  const state = getOrCreateState(sandboxId);

  if (state.isInitialized && state.previewUrl) {
    // User is still active — reset TTL so container isn't destroyed
    touchSandbox(sandboxId, state);
    return {
      status: "ready" as const,
      previewUrl: state.previewUrl,
      wsEndpoint: `/api/ws?sandboxId=${sandboxId}`,
    };
  }

  // Already initializing — don't start a second concurrent run.
  // The client's polling fallback will hit this branch repeatedly
  // until init completes.
  if (state.isInitializing) {
    return {
      status: "initializing" as const,
      wsEndpoint: `/api/ws?sandboxId=${sandboxId}`,
      message: "Initialization already in progress",
    };
  }

  // Previous init failed — return the error to the client.
  // DO NOT auto-retry here: the old behavior reset initError and
  // re-triggered initializeSandbox on every poll, causing an infinite
  // loop (especially with PortAlreadyExposedError). The user can retry
  // via the Retry button which reloads the page with a fresh sandboxId.
  if (state.initError) {
    return {
      status: "error" as const,
      wsEndpoint: `/api/ws?sandboxId=${sandboxId}`,
      message: state.initError,
    };
  }

  // Mark as initializing to prevent concurrent runs
  state.isInitializing = true;
  state.sandboxBinding = sandboxBinding;

  // Fire off initialization, kept alive via waitUntil.
  // Without waitUntil, the promise would be killed when the response is sent.
  const initPromise = initializeSandbox(sandboxId, host, sandboxBinding);
  if (waitUntil) {
    waitUntil(initPromise);
  }

  return {
    status: "initializing" as const,
    wsEndpoint: `/api/ws?sandboxId=${sandboxId}`,
    message: "Connect to WebSocket for progress updates",
  };
}
