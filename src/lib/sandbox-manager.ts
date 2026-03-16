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
 *
 * Readiness detection uses the SDK's `wsConnect()` — the browser opens a
 * WebSocket to `/api/ws` which proxies through the Sandbox DO and blocks
 * until the container + port are healthy. When `ws.onopen` fires client-side,
 * the client polls this manager once to retrieve the cached preview URL.
 *
 * ## Usage
 *
 * ```typescript
 * const manager = new SandboxManager({
 *   port: 3001,
 *   token: "slidev",
 *   sleepAfter: "5m",
 *   initialize: async ({ sandbox, progress }) => {
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
 * ```
 */

import type { Sandbox, ISandbox } from "@cloudflare/sandbox";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InitContext {
  /** Report a progress step (logged server-side). */
  progress: (step: string) => void;
  /** The sandbox handle — full SDK Sandbox stub via RPC. */
  sandbox: ISandbox;
  /** The host (e.g. "sandbox.cfsa.dev" or "localhost:4321"). */
  host: string;
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
   * Base path prefix for the preview URL. Appended to the exposed port
   * URL to namespace sandbox assets under a sub-path, avoiding route
   * collisions with the host app.
   * @default "/"
   */
  basePath?: string;

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
}

// ---------------------------------------------------------------------------
// Start/status response types
// ---------------------------------------------------------------------------

export type StartResult =
  | { status: "ready"; previewUrl: string }
  | { status: "initializing"; message: string }
  | { status: "error"; message: string };

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class SandboxManager {
  private readonly opts: Required<
    Pick<SandboxManagerOptions, "port" | "token" | "sleepAfter" | "basePath">
  > &
    SandboxManagerOptions;
  private readonly sandboxes = new Map<string, ManagedSandboxState>();

  constructor(opts: SandboxManagerOptions) {
    this.opts = {
      sleepAfter: "5m",
      basePath: "/",
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

    if (
      state.isInitialized &&
      state.previewUrl &&
      !this.hasExpectedToken(state.previewUrl)
    ) {
      state.isInitialized = false;
      state.previewUrl = null;
    }

    if (state.isInitialized && state.previewUrl) {
      return { status: "ready", previewUrl: state.previewUrl };
    }

    if (state.isInitializing) {
      return {
        status: "initializing",
        message: "Initialization already in progress",
      };
    }

    if (state.initError) {
      return { status: "error", message: state.initError };
    }

    state.isInitializing = true;

    const initPromise = this.runInit(sandboxId, host, sandboxBinding);
    if (waitUntil) {
      waitUntil(initPromise);
    }

    return {
      status: "initializing",
      message: "Initialization started",
    };
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
      };
      this.sandboxes.set(sandboxId, state);
    }
    return state;
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
      const { getSandbox } = await import("@cloudflare/sandbox");
      const sandbox = getSandbox(sandboxBinding, sandboxId, {
        normalizeId: true,
        sleepAfter: this.opts.sleepAfter,
      });

      // Recovery check: if the port is already exposed (isolate
      // eviction case), skip init and go straight to "ready".
      const existingUrl = await this.checkExistingPort(
        sandbox,
        sandboxId,
        host,
      );
      if (existingUrl) {
        const fullUrl = `${existingUrl.replace(/\/$/, "")}${this.opts.basePath}`;
        this.markReady(sandboxId, state, fullUrl);
        return;
      }

      // Run app-specific initialization
      const progress = (step: string) => {
        state.currentStep = step;
      };

      await this.opts.initialize({ sandbox, progress, host });

      // Expose port (with PortAlreadyExposed recovery)
      progress("exposing_port");
      const rawUrl = await this.exposePortSafe(sandbox, sandboxId, host);
      const previewUrl = `${rawUrl.replace(/\/$/, "")}${this.opts.basePath}`;

      this.markReady(sandboxId, state, previewUrl);
    } catch (error) {
      state.initError =
        error instanceof Error ? error.message : "Unknown error";
      state.isInitializing = false;
      state.currentStep = "";
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
        return existing.url;
      }
    } catch {
      // Container may not be running yet — proceed with init
    }
    return null;
  }

  /**
   * Expose the port, catching PortAlreadyExposed from race conditions
   * between the recovery check and the expose call.
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
      const code = (err as { code?: string }).code;
      if (code === "PORT_ALREADY_EXPOSED") {
        const ports = await sandbox.getExposedPorts(host);
        const existing = ports.find(
          (p) => p.port === this.opts.port && this.hasExpectedToken(p.url),
        );
        if (existing) {
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
