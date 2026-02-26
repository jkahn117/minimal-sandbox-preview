/**
 * Server-side lifecycle manager for Cloudflare Sandbox containers.
 *
 * Thin orchestration layer around the `@cloudflare/sandbox` SDK. The SDK
 * handles container lifecycle (`sleepAfter`), port exposure (with token),
 * process readiness (`waitForPort`), and request proxying (`proxyToSandbox`).
 *
 * This manager adds what the SDK does **not** provide:
 * - In-memory state machine per sandbox ID (idle → initializing → ready | error)
 * - Idempotent start (polling returns cached status)
 * - WebSocket broadcast of progress/ready/error events
 * - WebSocket upgrade handler for API routes
 *
 * ## Usage
 *
 * ```typescript
 * const manager = new SandboxManager({
 *   port: 3001,
 *   token: "vinext",
 *   sleepAfter: "5m",
 *   initialize: async (sandbox, { progress }) => {
 *     progress("writing_files");
 *     await sandbox.writeFile("/workspace/server.js", code);
 *     progress("starting_server");
 *     const proc = await sandbox.startProcess("node server.js", { cwd: "/workspace" });
 *     await proc.waitForPort(3001, { mode: "http", timeout: 90_000 });
 *   },
 * });
 *
 * // In your Astro action:
 * return manager.start(sandboxId, host, binding, waitUntil);
 *
 * // In your WS API route:
 * return manager.handleWebSocketUpgrade(request, sandboxId);
 * ```
 */

import type { Sandbox, ISandbox } from "@cloudflare/sandbox";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InitContext {
  /** Report a progress step to connected WebSocket clients. */
  progress: (step: string) => void;
  /** The sandbox handle — full SDK Sandbox stub via RPC. */
  sandbox: ISandbox;
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
   * Container auto-sleep duration. Passed to `getSandbox()`.
   * @default "5m"
   */
  sleepAfter?: string;

  /**
   * The WebSocket endpoint path pattern. `{sandboxId}` is replaced
   * with the actual ID.
   * @default "/api/ws?sandboxId={sandboxId}"
   */
  wsEndpointPattern?: string;

  /**
   * App-specific initialization logic. Called with a sandbox handle and
   * a `progress` reporter. Should write files, start processes, and
   * await readiness (e.g. `proc.waitForPort()`). Port exposure is
   * handled by the manager after this callback returns.
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
}

// ---------------------------------------------------------------------------
// Start/status response types
// ---------------------------------------------------------------------------

export type StartResult =
  | { status: "ready"; previewUrl: string; wsEndpoint: string }
  | { status: "initializing"; wsEndpoint: string; message: string }
  | { status: "error"; wsEndpoint: string; message: string };

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class SandboxManager {
  private readonly opts: Required<
    Pick<
      SandboxManagerOptions,
      "port" | "token" | "sleepAfter" | "wsEndpointPattern"
    >
  > &
    SandboxManagerOptions;
  private readonly sandboxes = new Map<string, ManagedSandboxState>();

  constructor(opts: SandboxManagerOptions) {
    this.opts = {
      sleepAfter: "5m",
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
   * - Already initialized → "ready" + preview URL
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

    if (
      state.isInitialized &&
      state.previewUrl &&
      !this.hasExpectedToken(state.previewUrl)
    ) {
      console.warn(
        `[sandbox:${sandboxId}] Cached preview URL token mismatch, forcing re-init: ${state.previewUrl}`,
      );
      state.isInitialized = false;
      state.previewUrl = null;
    }

    if (state.isInitialized && state.previewUrl) {
      return { status: "ready", previewUrl: state.previewUrl, wsEndpoint };
    }

    if (state.isInitializing) {
      return {
        status: "initializing",
        wsEndpoint,
        message: "Initialization already in progress",
      };
    }

    if (state.initError) {
      return { status: "error", wsEndpoint, message: state.initError };
    }

    state.isInitializing = true;

    const initPromise = this.runInit(sandboxId, host, sandboxBinding);
    if (waitUntil) {
      waitUntil(initPromise);
    }

    return {
      status: "initializing",
      wsEndpoint,
      message: "Connect to WebSocket for progress updates",
    };
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
      server.send(
        JSON.stringify({ type: "ready", previewUrl: state.previewUrl }),
      );
    } else if (state.initError) {
      server.send(JSON.stringify({ type: "error", message: state.initError }));
    } else if (state.currentStep) {
      server.send(
        JSON.stringify({ type: "progress", step: state.currentStep }),
      );
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
      };
      this.sandboxes.set(sandboxId, state);
    }
    return state;
  }

  private wsEndpoint(sandboxId: string): string {
    return this.opts.wsEndpointPattern.replace("{sandboxId}", sandboxId);
  }

  // -----------------------------------------------------------------------
  // Internal — broadcast
  // -----------------------------------------------------------------------

  private broadcast(
    state: ManagedSandboxState,
    message: Record<string, unknown>,
  ): void {
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async runInit(
    sandboxId: string,
    host: string,
    sandboxBinding: DurableObjectNamespace<any>,
  ): Promise<void> {
    const state = this.getOrCreate(sandboxId);

    try {
      console.log(`[sandbox:${sandboxId}] Starting initialization...`);

      const { getSandbox } = await import("@cloudflare/sandbox");
      const sandbox = getSandbox(sandboxBinding, sandboxId, {
        normalizeId: true,
        sleepAfter: this.opts.sleepAfter,
      });

      // --- Recovery check: if the port is already exposed (isolate
      // eviction case), skip init and go straight to "ready".
      const existingUrl = await this.checkExistingPort(
        sandbox,
        sandboxId,
        host,
      );
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

      // --- Expose port (with PortAlreadyExposed recovery) ---
      progress("exposing_port");
      const previewUrl = await this.exposePortSafe(sandbox, sandboxId, host);

      this.markReady(sandboxId, state, previewUrl);
      console.log(
        `[sandbox:${sandboxId}] Initialized successfully, preview: ${previewUrl}`,
      );
    } catch (error) {
      state.initError =
        error instanceof Error ? error.message : "Unknown error";
      state.isInitializing = false;
      state.currentStep = "";
      this.broadcast(state, { type: "error", message: state.initError });
      console.error(`Sandbox ${sandboxId} initialization failed:`, error);
    }
  }

  private markReady(
    sandboxId: string,
    state: ManagedSandboxState,
    previewUrl: string,
  ): void {
    state.previewUrl = previewUrl;
    state.isInitialized = true;
    state.isInitializing = false;
    state.currentStep = "ready";
    this.broadcast(state, { type: "ready", previewUrl });
  }

  /**
   * Check if the port is already exposed (isolate eviction recovery).
   * Returns the preview URL if found, null otherwise.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async checkExistingPort(
    sandbox: Sandbox<any>,
    sandboxId: string,
    host: string,
  ): Promise<string | null> {
    try {
      const ports = await sandbox.getExposedPorts(host);
      const existing = ports.find(
        (p) => p.port === this.opts.port && this.hasExpectedToken(p.url),
      );
      if (existing) {
        console.log(
          `[sandbox:${sandboxId}] Port ${this.opts.port} already exposed, reusing: ${existing.url}`,
        );
        return existing.url;
      }

      const mismatched = ports.find((p) => p.port === this.opts.port);
      if (mismatched) {
        console.warn(
          `[sandbox:${sandboxId}] Port ${this.opts.port} exposed with mismatched token, ignoring stale URL: ${mismatched.url}`,
        );
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
   * Expose the port, catching PortAlreadyExposed from race conditions
   * between the recovery check and the expose call.
   *
   * The SDK's PortAlreadyExposedError is not exported as a type, so we
   * check the error's `code` property instead of using `instanceof`.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async exposePortSafe(
    sandbox: Sandbox<any>,
    sandboxId: string,
    host: string,
  ): Promise<string> {
    try {
      const exposed = await sandbox.exposePort(this.opts.port, {
        hostname: host,
        name: this.opts.portName,
        token: this.opts.token,
      });
      return exposed.url;
    } catch (err) {
      // SDK throws PortAlreadyExposedError with code "PORT_ALREADY_EXPOSED"
      // but the class isn't exported in types — check the code property.
      const code = (err as { code?: string }).code;
      if (code === "PORT_ALREADY_EXPOSED") {
        // Port was exposed between our check and this call — recover
        // by fetching the existing URL.
        const ports = await sandbox.getExposedPorts(host);
        const existing = ports.find(
          (p) => p.port === this.opts.port && this.hasExpectedToken(p.url),
        );
        if (existing) {
          console.log(
            `[sandbox:${sandboxId}] Port already exposed (race), reusing: ${existing.url}`,
          );
          return existing.url;
        }

        const mismatched = ports.find((p) => p.port === this.opts.port);
        if (mismatched) {
          throw new Error(
            `Port ${this.opts.port} is already exposed with a different token (${mismatched.url}). Expected token "${this.opts.token}". Use a fresh sandboxId.`,
          );
        }
      }
      throw err;
    }
  }

  private hasExpectedToken(previewUrl: string): boolean {
    try {
      const hostname = new URL(previewUrl).hostname;
      const firstLabel = hostname.split(".")[0] ?? "";
      return firstLabel.endsWith(`-${this.opts.token}`);
    } catch {
      return false;
    }
  }
}
