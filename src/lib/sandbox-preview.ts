/**
 * Framework-agnostic client for tracking sandbox readiness.
 *
 * Uses two strategies in parallel to detect when the sandbox is ready:
 *
 * 1. **WebSocket (primary in production):** The SDK's `wsConnect()` proxies
 *    through the Sandbox Durable Object. The upgrade blocks until the
 *    container and target port are healthy, so `ws.onopen` = ready.
 *
 * 2. **Polling fallback:** After a configurable delay, polls the `poll()`
 *    callback on an interval until the server reports `status: "ready"`.
 *    This is the primary path in local development where the Vite dev
 *    server cannot proxy WebSocket upgrades to the Worker entrypoint.
 *
 * Whichever strategy resolves first wins — the other is cancelled via
 * `stopAll()`.
 *
 * ## Flow
 *
 * 1. Call `start()` to trigger server-side initialization (writeFile,
 *    startProcess, exposePort) via `waitUntil`
 * 2. If already ready → emit "ready" immediately
 * 3. Otherwise → start both WebSocket + polling fallback
 * 4. First to see "ready" wins → emit "ready", cancel the other
 * 5. Hard deadline at `maxWaitMs` emits error if neither succeeds
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
  wsEndpoint?: string;
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
   * Initial delay (ms) before retrying a failed WebSocket connection.
   * Doubles on each retry (exponential backoff).
   * @default 2000
   */
  wsRetryDelay?: number;

  /**
   * Maximum time (ms) to wait for the sandbox to become ready.
   * After this, an error is emitted.
   * @default 120000
   */
  maxWaitMs?: number;

  /**
   * Delay (ms) before the polling fallback kicks in. Gives the WS path
   * a brief head start. In local dev the WS path never works, so set
   * this to 0 for immediate polling.
   * @default 3000
   */
  pollFallbackDelayMs?: number;

  /**
   * Interval (ms) between poll attempts once the fallback is active.
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

  private ws: WebSocket | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private pollFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private pollIntervalTimer: ReturnType<typeof setTimeout> | null = null;
  private currentRetryDelay: number;

  /** True once a terminal state (ready or error) has been reached. */
  private settled = false;

  /** The WS endpoint path, extracted from the start() response. */
  private wsEndpoint: string | null = null;

  private listeners: {
    [E in EventName]?: Set<EventHandler<E>>;
  } = {};

  constructor(opts: SandboxPreviewOptions) {
    this.opts = {
      wsRetryDelay: 2_000,
      maxWaitMs: 120_000,
      pollFallbackDelayMs: 3_000,
      pollIntervalMs: 3_000,
      ...opts,
    };
    this.currentRetryDelay = this.opts.wsRetryDelay;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Kick off initialization. Call once after registering event listeners. */
  async init(): Promise<void> {
    console.log("[preview] init() called");
    try {
      this.emit("progress", { step: "starting" });

      console.log("[preview] calling start()...");
      const result = await this.opts.start();
      console.log("[preview] start() returned:", JSON.stringify(result));

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
        console.log("[preview] already ready, previewUrl:", data.previewUrl);
        this.emitReady(data.previewUrl);
        return;
      }

      // Already failed
      if (data.status === "error") {
        console.log("[preview] start returned error:", data.message);
        this.emitError(data.message ?? "Sandbox initialization failed");
        return;
      }

      // Initializing — connect WS and wait for the container to be ready
      this.wsEndpoint = data.wsEndpoint ?? null;
      if (!this.wsEndpoint) {
        this.emitError("No WebSocket endpoint returned from start()");
        return;
      }

      console.log("[preview] status=initializing, wsEndpoint:", this.wsEndpoint);
      this.emit("progress", { step: "waiting_for_ready" });
      this.scheduleDeadline();
      this.connectWebSocket();
      this.schedulePollFallback();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to start sandbox";
      console.error("[preview] init() failed:", err);
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
    console.log("[preview] emitReady:", previewUrl);
    this.stopAll();
    this.emit("ready", { previewUrl });
  }

  private emitError(message: string): void {
    console.error("[preview] emitError:", message);
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
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.pollFallbackTimer) {
      clearTimeout(this.pollFallbackTimer);
      this.pollFallbackTimer = null;
    }
    if (this.pollIntervalTimer) {
      clearTimeout(this.pollIntervalTimer);
      this.pollIntervalTimer = null;
    }
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close();
      this.ws = null;
    }
  }

  // -----------------------------------------------------------------------
  // Internal — WebSocket (readiness detection via wsConnect proxy)
  // -----------------------------------------------------------------------

  /**
   * Open a WebSocket to the wsConnect proxy endpoint. The SDK's wsConnect
   * blocks until the container is up and the target port is healthy before
   * completing the upgrade. So `onopen` = sandbox ready.
   *
   * On failure (container still provisioning, network error), we retry
   * with exponential backoff.
   */
  private connectWebSocket(): void {
    if (this.settled || !this.wsEndpoint) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}${this.wsEndpoint}`;

    console.log("[preview:ws] connecting to", url);
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      if (this.settled) {
        console.log("[preview:ws] onopen fired but already settled, ignoring");
        return;
      }
      console.log("[preview:ws] connected — sandbox is ready, fetching preview URL");
      this.fetchPreviewUrl();
    };

    this.ws.onerror = (event) => {
      if (this.settled) return;
      console.warn("[preview:ws] error", event);
    };

    this.ws.onclose = (event) => {
      if (this.settled) {
        console.log("[preview:ws] closed after settle (expected)");
        return;
      }
      console.log(
        `[preview:ws] closed (code=${event.code}, reason="${event.reason}", clean=${event.wasClean}), retrying in ${this.currentRetryDelay}ms`,
      );
      this.scheduleRetry();
    };
  }

  /**
   * After the WS connects (sandbox ready), poll the start action once
   * to retrieve the cached preview URL.
   */
  private async fetchPreviewUrl(): Promise<void> {
    console.log("[preview:ws] fetchPreviewUrl called");
    try {
      const result = await this.opts.poll();
      console.log("[preview:ws] poll returned:", JSON.stringify(result));
      if (result.error) {
        this.emitError(result.error.message ?? "Failed to get preview URL");
        return;
      }

      const data = result.data;
      if (data?.status === "ready" && data.previewUrl) {
        console.log("[preview:ws] poll says ready:", data.previewUrl);
        this.emitReady(data.previewUrl);
      } else if (data?.status === "error") {
        this.emitError(data.message ?? "Sandbox initialization failed");
      } else {
        // Init may still be running (exposePort not done yet). Retry poll.
        console.log(
          "[preview:ws] WS connected but init not complete (status=%s), re-polling in 2s",
          data?.status,
        );
        this.emit("progress", { step: "exposing_port" });
        setTimeout(() => {
          if (!this.settled) this.fetchPreviewUrl();
        }, 2_000);
      }
    } catch (err) {
      console.error("[preview:ws] fetchPreviewUrl failed:", err);
      this.emitError(
        err instanceof Error ? err.message : "Failed to get preview URL",
      );
    }
  }

  // -----------------------------------------------------------------------
  // Internal — retry with exponential backoff
  // -----------------------------------------------------------------------

  private scheduleRetry(): void {
    if (this.settled) return;
    this.retryTimer = setTimeout(() => {
      if (this.settled) return;
      this.connectWebSocket();
    }, this.currentRetryDelay);

    // Exponential backoff, capped at 15s
    this.currentRetryDelay = Math.min(this.currentRetryDelay * 1.5, 15_000);
  }

  // -----------------------------------------------------------------------
  // Internal — polling fallback
  // -----------------------------------------------------------------------

  /**
   * Schedule a polling fallback that kicks in after `pollFallbackDelayMs`.
   * In local dev (delay = 0) this starts immediately; in production the
   * WebSocket path usually wins before polling begins.
   */
  private schedulePollFallback(): void {
    const delay = this.opts.pollFallbackDelayMs;
    console.log(
      `[preview:poll] fallback scheduled in ${delay}ms (interval: ${this.opts.pollIntervalMs}ms)`,
    );
    this.pollFallbackTimer = setTimeout(() => {
      if (this.settled) {
        console.log("[preview:poll] fallback fired but already settled, skipping");
        return;
      }
      console.log("[preview:poll] fallback active, starting to poll");
      this.pollForReady();
    }, delay);
  }

  /**
   * Poll the server for readiness. If the status is "ready", emit and
   * stop. Otherwise schedule the next poll after `pollIntervalMs`.
   */
  private async pollForReady(): Promise<void> {
    if (this.settled) return;

    try {
      console.log("[preview:poll] polling...");
      const result = await this.opts.poll();
      if (this.settled) return;

      if (result.error) {
        console.warn("[preview:poll] error (will retry):", result.error.message);
      } else {
        const data = result.data;
        console.log("[preview:poll] status=%s previewUrl=%s", data?.status, data?.previewUrl ?? "(none)");
        if (data?.status === "ready" && data.previewUrl) {
          console.log("[preview:poll] detected ready");
          this.emitReady(data.previewUrl);
          return;
        }
        if (data?.status === "error") {
          this.emitError(data.message ?? "Sandbox initialization failed");
          return;
        }
      }
    } catch (err) {
      console.warn(
        "[preview:poll] fetch failed (will retry):",
        err instanceof Error ? err.message : err,
      );
    }

    // Schedule next poll
    console.log("[preview:poll] next poll in %dms", this.opts.pollIntervalMs);
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
    console.log("[preview] deadline set: %dms", this.opts.maxWaitMs);
    this.deadlineTimer = setTimeout(() => {
      if (this.settled) return;
      console.error("[preview] DEADLINE exceeded (%dms)", this.opts.maxWaitMs);
      this.emitError("Sandbox initialization timed out");
    }, this.opts.maxWaitMs);
  }
}
