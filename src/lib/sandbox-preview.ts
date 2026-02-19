/**
 * Framework-agnostic client for tracking long-running sandbox initialization.
 *
 * Manages a WebSocket connection (primary) with deferred polling fallback
 * to track server-side progress and notify the consumer when a sandbox
 * preview URL is ready.
 *
 * ## Why both WebSocket and polling?
 *
 * Sandbox initialization runs server-side inside `waitUntil()`, which is
 * a different I/O context than the WebSocket connections. In workerd,
 * broadcasts from `waitUntil` don't reliably reach WS clients connected
 * in a different request. Polling covers this gap — but only activates
 * if WebSocket is silent, to avoid wasteful duplicate requests.
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
   * Check server-side status. Called periodically as a fallback when
   * WebSocket is silent. Should be idempotent and cheap.
   */
  poll: () => Promise<ActionResult>;

  /**
   * Grace period (ms) before polling activates. Gives the WebSocket
   * time to deliver before falling back.
   * @default 5000
   */
  pollFallbackDelay?: number;

  /**
   * Polling interval (ms). Intentionally slow since this is a backup.
   * @default 5000
   */
  pollInterval?: number;

  /**
   * Delay (ms) before auto-reconnecting a closed WebSocket.
   * @default 3000
   */
  wsReconnectDelay?: number;
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
type EventHandler<E extends EventName> = (payload: SandboxPreviewEvents[E]) => void;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class SandboxPreview {
  private readonly opts: Required<SandboxPreviewOptions>;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private ws: WebSocket | null = null;

  /** True once a terminal state (ready or error) has been reached. */
  private settled = false;

  /** True once the WebSocket has delivered a substantive message. */
  private wsHasDelivered = false;

  private listeners: {
    [E in EventName]?: Set<EventHandler<E>>;
  } = {};

  constructor(opts: SandboxPreviewOptions) {
    this.opts = {
      pollFallbackDelay: 5_000,
      pollInterval: 5_000,
      wsReconnectDelay: 3_000,
      ...opts,
    };
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Kick off initialization. Call once after registering event listeners. */
  async init(): Promise<void> {
    try {
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

      // Initializing — connect WS + schedule poll fallback
      if (data.wsEndpoint) {
        this.connectWebSocket(data.wsEndpoint);
      }
      this.schedulePollFallback();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start sandbox";
      console.error("SandboxPreview.init() failed:", err);
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

  private emit<E extends EventName>(event: E, payload: SandboxPreviewEvents[E]): void {
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
    if (this.pollFallbackTimer) {
      clearTimeout(this.pollFallbackTimer);
      this.pollFallbackTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null; // prevent auto-reconnect
      this.ws.close();
      this.ws = null;
    }
  }

  // -----------------------------------------------------------------------
  // Internal — WebSocket
  // -----------------------------------------------------------------------

  private connectWebSocket(endpoint: string): void {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    this.ws = new WebSocket(
      `${protocol}//${window.location.host}${endpoint}`,
    );

    this.ws.onmessage = (event: MessageEvent) => {
      const data = JSON.parse(event.data);
      // Only count substantive messages as "delivered". A handshake ack
      // (e.g. { type: "connected" }) doesn't carry init state and must
      // not suppress the polling fallback.
      if (data.type === "progress" || data.type === "ready" || data.type === "error") {
        this.wsHasDelivered = true;
      }
      this.handleMessage(data);
    };

    this.ws.onerror = () => {
      console.warn("SandboxPreview: WebSocket error, relying on polling fallback");
    };

    this.ws.onclose = () => {
      if (this.settled) return;
      // Auto-reconnect — WS may close during container startup.
      setTimeout(
        () => this.connectWebSocket(endpoint),
        this.opts.wsReconnectDelay,
      );
    };
  }

  private handleMessage(data: Record<string, string>): void {
    switch (data.type) {
      case "progress":
        this.emit("progress", { step: data.step });
        break;
      case "ready":
        this.emitReady(data.previewUrl);
        break;
      case "error":
        this.emitError(data.message);
        break;
    }
  }

  // -----------------------------------------------------------------------
  // Internal — polling fallback
  // -----------------------------------------------------------------------

  /**
   * Schedule the polling fallback with a delay. If WebSocket delivers
   * any substantive message before the timer fires, polling is skipped.
   */
  private schedulePollFallback(): void {
    this.pollFallbackTimer = setTimeout(() => {
      if (this.settled || this.wsHasDelivered) return;
      console.warn("SandboxPreview: WebSocket silent after timeout — starting poll fallback");
      this.startPolling();
    }, this.opts.pollFallbackDelay);
  }

  /**
   * Poll the server to check for ready/error state. Self-cancels if
   * WebSocket comes alive mid-poll.
   */
  private startPolling(): void {
    if (this.pollTimer) return; // guard against duplicate timers
    this.pollTimer = setInterval(async () => {
      if (this.settled || this.wsHasDelivered) {
        if (this.pollTimer) {
          clearInterval(this.pollTimer);
          this.pollTimer = null;
        }
        return;
      }
      try {
        const result = await this.opts.poll();
        if (result.error) return;

        const data = result.data;
        if (!data) return;

        if (data.status === "ready" && data.previewUrl) {
          this.emitReady(data.previewUrl);
        } else if (data.status === "error") {
          this.emitError(data.message ?? "Sandbox initialization failed");
        }
      } catch {
        // Swallow poll errors — this is a fallback, not critical path
      }
    }, this.opts.pollInterval);
  }
}
