/**
 * Server-side lifecycle manager for Cloudflare Sandbox containers.
 *
 * Handles the boilerplate that every Sandbox SDK project needs:
 * - In-memory state tracking per sandbox ID
 * - Idempotent start (idle → initializing → ready | error)
 * - TTL-based cleanup with `sleepAfter` as a safety net
 * - Isolate eviction recovery via `getExposedPorts()`
 * - `PortAlreadyExposedError` handling
 * - WebSocket connection tracking and broadcast
 * - WebSocket upgrade handler for API routes
 *
 * The consumer provides an `initialize` callback with their app-specific
 * logic (write files, start processes, health checks). This library
 * handles everything around it.
 *
 * ## Usage
 *
 * ```typescript
 * const manager = new SandboxManager({
 *   port: 3001,
 *   token: "express",
 *   sleepAfter: "5m",
 *   ttlMs: 5 * 60 * 1000,
 *   initialize: async (sandbox, { progress }) => {
 *     progress("writing_files");
 *     await sandbox.writeFile("/workspace/server.js", code);
 *     progress("starting_server");
 *     await sandbox.startProcess("node server.js", { cwd: "/workspace" });
 *     // ... health checks etc.
 *   },
 * });
 *
 * // In your Astro action:
 * return manager.start(sandboxId, host, binding, waitUntil);
 *
 * // In your WS API route:
 * return manager.handleWebSocketUpgrade(request, sandboxId);
 *
 * // Exported for the action/WS route if needed:
 * const state = manager.getPublicState(sandboxId);
 * ```
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Opaque sandbox handle — matches the shape returned by getSandbox(). */
export interface SandboxHandle {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
  writeFile(path: string, content: string): Promise<unknown>;
  exec(command: string, options?: { cwd?: string; env?: Record<string, string>; timeout?: number }): Promise<{ stdout: string; stderr: string; exitCode: number; success: boolean }>;
  startProcess(command: string, options?: { cwd?: string; env?: Record<string, string> }): Promise<unknown>;
  exposePort(port: number, options: { hostname: string; name?: string; token?: string }): Promise<{ url: string; port: number; name?: string }>;
  getExposedPorts(): Promise<unknown>;
  destroy(): Promise<void>;
}

export interface InitContext {
  /** Report a progress step to connected WebSocket clients. */
  progress: (step: string) => void;
  /** The sandbox handle — convenience alias. */
  sandbox: SandboxHandle;
}

export interface SandboxManagerOptions {
  /** The port to expose for the preview URL. */
  port: number;

  /**
   * Token for port exposure. Used in the preview URL pattern:
   * `https://{port}-{sandboxId}-{token}.{host}/`
   */
  token: string;

  /**
   * Name for the exposed port (optional, passed to `exposePort`).
   */
  portName?: string;

  /**
   * Container auto-sleep duration. Passed to `getSandbox()` as a
   * safety net for isolate eviction. Should be aligned with `ttlMs`.
   * @default "5m"
   */
  sleepAfter?: string;

  /**
   * JS-level TTL in milliseconds. After this duration of inactivity,
   * the container is explicitly destroyed via `sandbox.destroy()`.
   * Reset on every `start()` call (polling keeps it alive).
   * @default 300000 (5 minutes)
   */
  ttlMs?: number;

  /**
   * The WebSocket endpoint path pattern. `{sandboxId}` is replaced
   * with the actual ID.
   * @default "/api/ws?sandboxId={sandboxId}"
   */
  wsEndpointPattern?: string;

  /**
   * App-specific initialization logic. Called with a sandbox handle and
   * a `progress` reporter. Should write files, start processes, run
   * health checks — whatever the app needs. Port exposure is handled
   * by the manager after this callback returns.
   *
   * Throw an error to signal initialization failure.
   */
  initialize: (ctx: InitContext) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface ManagedSandboxState {
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

// ---------------------------------------------------------------------------
// Start/status response types
// ---------------------------------------------------------------------------

export type StartResult =
  | { status: "ready"; previewUrl: string; wsEndpoint: string }
  | { status: "initializing"; wsEndpoint: string; message: string }
  | { status: "error"; wsEndpoint: string; message: string };

export interface PublicState {
  isInitialized: boolean;
  previewUrl: string | null;
  currentStep: string;
  initError: string | null;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class SandboxManager {
  private readonly opts: Required<Pick<SandboxManagerOptions, "port" | "token" | "sleepAfter" | "ttlMs" | "wsEndpointPattern">> & SandboxManagerOptions;
  private readonly sandboxes = new Map<string, ManagedSandboxState>();

  constructor(opts: SandboxManagerOptions) {
    this.opts = {
      sleepAfter: "5m",
      ttlMs: 5 * 60 * 1000,
      wsEndpointPattern: "/api/ws?sandboxId={sandboxId}",
      ...opts,
    };
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Idempotent start. Returns current status for the client.
   *
   * - Already initialized → "ready" + preview URL (resets TTL)
   * - Currently initializing → "initializing" (no-op)
   * - Previous error → "error" (user must retry with fresh sandboxId)
   * - Otherwise → kicks off initialization, returns "initializing"
   */
  start(
    sandboxId: string,
    host: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sandboxBinding: DurableObjectNamespace<any>,
    waitUntil?: (promise: Promise<unknown>) => void,
  ): StartResult {
    const state = this.getOrCreate(sandboxId);
    const wsEndpoint = this.wsEndpoint(sandboxId);

    if (state.isInitialized && state.previewUrl) {
      this.touch(sandboxId, state);
      return { status: "ready", previewUrl: state.previewUrl, wsEndpoint };
    }

    if (state.isInitializing) {
      return { status: "initializing", wsEndpoint, message: "Initialization already in progress" };
    }

    if (state.initError) {
      return { status: "error", wsEndpoint, message: state.initError };
    }

    state.isInitializing = true;
    state.sandboxBinding = sandboxBinding;

    const initPromise = this.runInit(sandboxId, host, sandboxBinding);
    if (waitUntil) {
      waitUntil(initPromise);
    }

    return { status: "initializing", wsEndpoint, message: "Connect to WebSocket for progress updates" };
  }

  /**
   * Handle a WebSocket upgrade request. Call from your API route.
   * Returns a 101 Response with the WebSocket attached, or a 400 if
   * the request isn't a valid upgrade.
   */
  handleWebSocketUpgrade(request: Request, sandboxId: string): Response {
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader !== "websocket") {
      return new Response("Expected websocket", { status: 400 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    const state = this.getOrCreate(sandboxId);

    server.accept();
    state.connections.add(server);

    // Send current state to newly connected client. If no progress
    // yet, stay silent — avoid a meaningless "connected" ack that
    // would suppress the client's polling fallback.
    if (state.isInitialized && state.previewUrl) {
      server.send(JSON.stringify({ type: "ready", previewUrl: state.previewUrl }));
    } else if (state.initError) {
      server.send(JSON.stringify({ type: "error", message: state.initError }));
    } else if (state.currentStep) {
      server.send(JSON.stringify({ type: "progress", step: state.currentStep }));
    }

    server.addEventListener("close", () => {
      state.connections.delete(server);
    });

    return new Response(null, {
      status: 101,
      // @ts-ignore — webSocket property exists in Cloudflare Workers runtime
      webSocket: client,
    });
  }

  /** Get read-only state for external inspection. */
  getPublicState(sandboxId: string): PublicState {
    const state = this.getOrCreate(sandboxId);
    return {
      isInitialized: state.isInitialized,
      previewUrl: state.previewUrl,
      currentStep: state.currentStep,
      initError: state.initError,
    };
  }

  /** Get the WebSocket connections set (for advanced use). */
  getConnections(sandboxId: string): Set<WebSocket> {
    return this.getOrCreate(sandboxId).connections;
  }

  // -----------------------------------------------------------------------
  // Internal — state management
  // -----------------------------------------------------------------------

  private getOrCreate(sandboxId: string): ManagedSandboxState {
    let state = this.sandboxes.get(sandboxId);
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
      this.sandboxes.set(sandboxId, state);
    }
    return state;
  }

  private wsEndpoint(sandboxId: string): string {
    return this.opts.wsEndpointPattern.replace("{sandboxId}", sandboxId);
  }

  // -----------------------------------------------------------------------
  // Internal — TTL cleanup
  // -----------------------------------------------------------------------

  private touch(sandboxId: string, state: ManagedSandboxState): void {
    state.lastActivity = Date.now();
    this.scheduleDestroy(sandboxId, state);
  }

  private scheduleDestroy(sandboxId: string, state: ManagedSandboxState): void {
    if (state.destroyTimer) {
      clearTimeout(state.destroyTimer);
    }
    state.destroyTimer = setTimeout(
      () => this.destroySandbox(sandboxId),
      this.opts.ttlMs,
    );
  }

  private async destroySandbox(sandboxId: string): Promise<void> {
    const state = this.sandboxes.get(sandboxId);
    if (!state) return;

    console.log(`[sandbox:${sandboxId}] TTL expired, destroying container...`);

    // Close all WS connections
    for (const ws of state.connections) {
      try { ws.close(); } catch { /* ignore */ }
    }

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

    if (state.destroyTimer) clearTimeout(state.destroyTimer);
    this.sandboxes.delete(sandboxId);
  }

  // -----------------------------------------------------------------------
  // Internal — broadcast
  // -----------------------------------------------------------------------

  private broadcast(state: ManagedSandboxState, message: Record<string, unknown>): void {
    const data = JSON.stringify(message);
    for (const ws of state.connections) {
      try {
        ws.send(data);
      } catch {
        state.connections.delete(ws);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Internal — initialization
  // -----------------------------------------------------------------------

  private markReady(sandboxId: string, state: ManagedSandboxState, previewUrl: string): void {
    state.previewUrl = previewUrl;
    state.isInitialized = true;
    state.isInitializing = false;
    state.currentStep = "ready";
    this.touch(sandboxId, state);
    this.broadcast(state, { type: "ready", previewUrl });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async runInit(sandboxId: string, host: string, sandboxBinding: DurableObjectNamespace<any>): Promise<void> {
    const state = this.getOrCreate(sandboxId);
    state.sandboxBinding = sandboxBinding;

    try {
      console.log(`[sandbox:${sandboxId}] Starting initialization...`);

      const { getSandbox } = await import("@cloudflare/sandbox");
      const sandbox = getSandbox(sandboxBinding, sandboxId, {
        normalizeId: true,
        sleepAfter: this.opts.sleepAfter,
      }) as unknown as SandboxHandle;

      // --- Recovery check: if the port is already exposed (isolate
      // eviction case), skip init and go straight to "ready".
      const existingUrl = await this.checkExistingPort(sandbox, sandboxId, host);
      if (existingUrl) {
        this.markReady(sandboxId, state, existingUrl);
        return;
      }

      // --- Run app-specific initialization ---
      const progress = (step: string) => {
        state.currentStep = step;
        this.broadcast(state, { type: "progress", step });
      };

      await this.opts.initialize({ sandbox, progress });

      // --- Expose port (with PortAlreadyExposedError recovery) ---
      progress("exposing_port");
      const previewUrl = await this.exposePortSafe(sandbox, sandboxId, host);

      this.markReady(sandboxId, state, previewUrl);
      console.log(
        `[sandbox:${sandboxId}] Initialized successfully, preview:`,
        previewUrl,
        `(TTL: ${this.opts.ttlMs / 1000}s)`,
      );
    } catch (error) {
      state.initError = error instanceof Error ? error.message : "Unknown error";
      state.isInitializing = false;
      state.currentStep = "";
      this.broadcast(state, { type: "error", message: state.initError });
      console.error(`[sandbox:${sandboxId}] Failed to initialize:`, error);
    }
  }

  /**
   * Check if the port is already exposed (isolate eviction recovery).
   * Returns the preview URL if found, null otherwise.
   */
  private async checkExistingPort(sandbox: SandboxHandle, sandboxId: string, host: string): Promise<string | null> {
    try {
      const exposedResult = await sandbox.getExposedPorts();
      // SDK may return { ports: [...] } or the array directly
      const result = exposedResult as { ports?: { port?: number }[] } | { port?: number }[];
      const ports = Array.isArray(result)
        ? result
        : Array.isArray(result?.ports)
          ? result.ports
          : [];
      const existing = ports.find(
        (p: { port?: number }) => p.port === this.opts.port,
      );
      if (existing) {
        const url = this.buildPreviewUrl(sandboxId, host);
        console.log(`[sandbox:${sandboxId}] Port ${this.opts.port} already exposed, reusing: ${url}`);
        return url;
      }
    } catch (err) {
      // Container may not be running yet — proceed with init
      console.log(
        `[sandbox:${sandboxId}] Could not check exposed ports (container may be new):`,
        err instanceof Error ? err.message : err,
      );
    }
    return null;
  }

  /**
   * Expose the port, catching PortAlreadyExposedError from race
   * conditions between the recovery check and the expose call.
   */
  private async exposePortSafe(sandbox: SandboxHandle, sandboxId: string, host: string): Promise<string> {
    try {
      const exposed = await sandbox.exposePort(this.opts.port, {
        hostname: host,
        name: this.opts.portName,
        token: this.opts.token,
      });
      return exposed.url;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("PortAlreadyExposedError") || msg.includes("already exposed")) {
        const url = this.buildPreviewUrl(sandboxId, host);
        console.log(`[sandbox:${sandboxId}] Port already exposed, reusing URL: ${url}`);
        return url;
      }
      throw err;
    }
  }

  private buildPreviewUrl(sandboxId: string, host: string): string {
    return `https://${this.opts.port}-${sandboxId}-${this.opts.token}.${host}/`;
  }
}
