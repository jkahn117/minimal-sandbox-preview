/**
 * Framework-agnostic client for tracking sandbox readiness.
 *
 * Polls the server until the sandbox reports `status: "ready"` with a
 * preview URL. Vite HMR inside the sandbox iframe handles live updates
 * after the initial load.
 *
 * ## Flow
 *
 * 1. Call `start()` to trigger server-side initialization (writeFile,
 *    startProcess, exposePort) via `waitUntil`
 * 2. If already ready → emit "ready" immediately
 * 3. Otherwise → poll on an interval until ready
 * 4. Hard deadline at `maxWaitMs` emits error if not reached
 *
 * ## Usage
 *
 * ```typescript
 * const preview = new SandboxPreview({
 *   start: () => actions.startSandbox({ sandboxId, host }),
 *   poll: () => actions.startSandbox({ sandboxId, host }),
 * });
 *
 * preview.on("progress", ({ step }) => updateUI(step));
 * preview.on("ready", ({ previewUrl }) => showIframe(previewUrl));
 * preview.on("error", ({ message }) => showError(message));
 *
 * preview.init();
 *
 * // Later, when the component unmounts:
 * preview.destroy();
 * ```
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The shape returned by both `start()` and `poll()` callbacks. */
export interface SandboxStatus {
  status: "ready" | "initializing" | "error";
  previewUrl?: string;
  message?: string;
}

/**
 * Result wrapper matching Astro Actions' `{ data, error }` pattern.
 * If your RPC layer uses a different shape, adapt accordingly.
 */
export interface ActionResult {
  data?: SandboxStatus;
  error?: { message?: string };
}

export interface SandboxPreviewOptions {
  /**
   * Trigger server-side initialization and return current status.
   * Called once on `init()`. Should return the initial status and a
   * `wsEndpoint` for the WebSocket connection.
   */
  start: () => Promise<ActionResult>;

  /**
   * Check server-side status. Called after the WebSocket connects to
   * retrieve the preview URL. Should be idempotent and cheap.
   */
  poll: () => Promise<ActionResult>;

  /**
   * Maximum time (ms) to wait for the sandbox to become ready.
   * After this, an error is emitted.
   * @default 120000
   */
  maxWaitMs?: number;

  /**
   * Delay (ms) before polling begins. Allows the server-side init to
   * make progress before the first poll.
   * @default 3000
   */
  pollDelayMs?: number;

  /**
   * Interval (ms) between poll attempts.
   * @default 3000
   */
  pollIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export interface SandboxPreviewEvents {
  /** Emitted for each initialization step reported by the server. */
  progress: { step: string };

  /** Emitted when the sandbox is ready with a preview URL. Terminal. */
  ready: { previewUrl: string };

  /** Emitted when initialization fails. Terminal. */
  error: { message: string };
}

type EventName = keyof SandboxPreviewEvents;
type EventHandler<E extends EventName> = (
  payload: SandboxPreviewEvents[E],
) => void;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class SandboxPreview {
  private readonly opts: Required<SandboxPreviewOptions>;

  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private pollFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private pollIntervalTimer: ReturnType<typeof setTimeout> | null = null;

  /** True once a terminal state (ready or error) has been reached. */
  private settled = false;

  private listeners: {
    [E in EventName]?: Set<EventHandler<E>>;
  } = {};

  constructor(opts: SandboxPreviewOptions) {
    this.opts = {
      maxWaitMs: 120_000,
      pollDelayMs: 3_000,
      pollIntervalMs: 3_000,
      ...opts,
    };
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Kick off initialization. Call once after registering event listeners. */
  async init(): Promise<void> {
    try {
      this.emit("progress", { step: "starting" });

      const result = await this.opts.start();

      if (result.error) {
        this.emitError(result.error.message ?? "Failed to start sandbox");
        return;
      }

      const data = result.data;
      if (!data) {
        this.emitError("No data returned from start()");
        return;
      }

      // Already ready (e.g. page refresh while container still alive)
      if (data.status === "ready" && data.previewUrl) {
        this.emitReady(data.previewUrl);
        return;
      }

      // Already failed
      if (data.status === "error") {
        this.emitError(data.message ?? "Sandbox initialization failed");
        return;
      }

      // Initializing — poll until the server reports ready
      this.emit("progress", { step: "waiting_for_ready" });
      this.scheduleDeadline();
      this.schedulePollFallback();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to start sandbox";
      this.emitError(message);
    }
  }

  /** Register a listener for an event. Returns an unsubscribe function. */
  on<E extends EventName>(event: E, handler: EventHandler<E>): () => void {
    let set = this.listeners[event] as Set<EventHandler<E>> | undefined;
    if (!set) {
      set = new Set<EventHandler<E>>();
      (this.listeners as Record<string, unknown>)[event] = set;
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  /** Clean up all timers, connections, and listeners. */
  destroy(): void {
    this.stopAll();
    this.listeners = {};
  }

  /** Whether the preview has reached a terminal state. */
  get isSettled(): boolean {
    return this.settled;
  }

  // -----------------------------------------------------------------------
  // Internal — event emission
  // -----------------------------------------------------------------------

  private emit<E extends EventName>(
    event: E,
    payload: SandboxPreviewEvents[E],
  ): void {
    const handlers = this.listeners[event] as Set<EventHandler<E>> | undefined;
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`SandboxPreview: error in "${event}" handler:`, err);
      }
    }
  }

  private emitReady(previewUrl: string): void {
    this.stopAll();
    this.emit("ready", { previewUrl });
  }

  private emitError(message: string): void {
    this.stopAll();
    this.emit("error", { message });
  }

  // -----------------------------------------------------------------------
  // Internal — cleanup
  // -----------------------------------------------------------------------

  private stopAll(): void {
    this.settled = true;
    if (this.deadlineTimer) {
      clearTimeout(this.deadlineTimer);
      this.deadlineTimer = null;
    }
    if (this.pollFallbackTimer) {
      clearTimeout(this.pollFallbackTimer);
      this.pollFallbackTimer = null;
    }
    if (this.pollIntervalTimer) {
      clearTimeout(this.pollIntervalTimer);
      this.pollIntervalTimer = null;
    }
  }

  // -----------------------------------------------------------------------
  // Internal — polling
  // -----------------------------------------------------------------------

  /**
   * Schedule a polling fallback that kicks in after `pollFallbackDelayMs`.
   * In local dev (delay = 0) this starts immediately; in production the
   * WebSocket path usually wins before polling begins.
   */
  private schedulePollFallback(): void {
    this.pollFallbackTimer = setTimeout(() => {
      if (this.settled) return;
      this.pollForReady();
    }, this.opts.pollDelayMs);
  }

  /**
   * Poll the server for readiness. If the status is "ready", emit and
   * stop. Otherwise schedule the next poll after `pollIntervalMs`.
   */
  private async pollForReady(): Promise<void> {
    if (this.settled) return;

    try {
      const result = await this.opts.poll();
      if (this.settled) return;

      if (result.error) {
        // Transient errors during init are expected — keep polling
      } else {
        const data = result.data;
        if (data?.status === "ready" && data.previewUrl) {
          this.emitReady(data.previewUrl);
          return;
        }
        if (data?.status === "error") {
          this.emitError(data.message ?? "Sandbox initialization failed");
          return;
        }
      }
    } catch {
      // Network errors — keep polling
    }

    this.pollIntervalTimer = setTimeout(() => {
      if (!this.settled) this.pollForReady();
    }, this.opts.pollIntervalMs);
  }

  // -----------------------------------------------------------------------
  // Internal — deadline
  // -----------------------------------------------------------------------

  /**
   * Hard deadline. If no terminal state (ready/error) is reached within
   * `maxWaitMs`, emit an error and stop everything.
   */
  private scheduleDeadline(): void {
    this.deadlineTimer = setTimeout(() => {
      if (this.settled) return;
      this.emitError("Sandbox initialization timed out");
    }, this.opts.maxWaitMs);
  }
}
