# Cloudflare Sandbox SDK Minimal Example

A working demonstration of Cloudflare's Sandbox SDK using **Astro v6 beta** with the Cloudflare adapter. Runs a Vue + Vite dev server inside an isolated container, with real-time WebSocket progress updates during initialization and a live editor/preview workflow.

Live at: **https://sandbox.cfsa.dev**

## Hot reload in preview

The editor writes directly to the running sandbox filesystem (for example,
`/workspace/app/src/App.vue`). After each successful write, the server action
calls an internal Vite endpoint (`/__sandbox_hmr`) inside the container to
trigger a reload event over Vite's HMR websocket.

If HMR clients are unavailable, the UI falls back to a deterministic iframe
refresh by updating the preview URL with a cache-busting query parameter. This
keeps preview updates reliable even when websocket HMR is temporarily
unavailable.

## Reusable libraries

This project includes two libraries extracted from the implementation that handle the boilerplate every Sandbox SDK project needs. They live in `src/lib/` and are ready to copy into other projects or extract into a shared package.

### `SandboxManager` — Server-side lifecycle manager

**File:** `src/lib/sandbox-manager.ts`

Handles everything around your app-specific initialization logic: state tracking, TTL cleanup, WebSocket broadcasts, isolate eviction recovery, and `PortAlreadyExposedError` handling.

```typescript
import { SandboxManager } from "./lib/sandbox-manager";

const manager = new SandboxManager({
  // Which port to expose as the preview URL
  port: 3001,
  // Token for the preview URL pattern: https://{port}-{sandboxId}-{token}.{host}/
  token: "my-app",
  // Optional: name for the exposed port
  portName: "my-server",
  // Container auto-sleep at the DO level (safety net for isolate eviction)
  sleepAfter: "5m",
  // JS-level TTL — destroys container after inactivity
  ttlMs: 5 * 60 * 1000,

  // Your app-specific init logic. This is the only part that changes
  // between projects. The manager handles everything else.
  async initialize({ sandbox, progress }) {
    progress("writing_files");
    await sandbox.writeFile("/workspace/server.js", myServerCode);

    progress("starting_server");
    await sandbox.startProcess("node server.js", {
      cwd: "/workspace",
      env: { PORT: "3001" },
    });

    progress("waiting_for_ready");
    // ... your health check logic ...

    // Don't call exposePort() here — the manager does it after
    // this callback returns, with PortAlreadyExposedError handling.
  },
});
```

**What the manager handles for you:**

| Concern | What it does |
|---|---|
| **Idempotent start** | State machine: idle → initializing → ready \| error. Safe to call from polling. |
| **TTL cleanup** | `setTimeout`-based destroy with `touch()` on every status check. Configurable via `ttlMs`. |
| **`sleepAfter` safety net** | Passed to `getSandbox()` so containers auto-sleep even if the isolate is evicted before the JS timer fires. |
| **Isolate eviction recovery** | Calls `getExposedPorts()` before init. If the port is already exposed (container survived an isolate eviction), skips init and goes to "ready". |
| **`PortAlreadyExposedError`** | Caught on `exposePort()`. Reconstructs the preview URL from the known pattern and treats it as success. |
| **WebSocket broadcast** | Tracks connections, broadcasts progress/ready/error to all clients. Dead connections are pruned automatically. |
| **WS upgrade handler** | `handleWebSocketUpgrade(request, sandboxId)` — handles the full upgrade lifecycle. Sends current state to newly connected clients. |
| **No "connected" ack** | Avoids sending a meaningless handshake that would suppress the client's polling fallback. |

**Using in an Astro action:**

```typescript
// src/actions/index.ts
import { sandboxManager } from "../lib/sandbox";

export const server = {
  startSandbox: defineAction({
    input: z.object({ sandboxId: z.string(), host: z.string() }),
    handler: async (input, context) => {
      const { cfContext } = context.locals;
      const { Sandbox } = env as Env;
      return sandboxManager.start(
        input.sandboxId,
        input.host,
        Sandbox,
        cfContext.waitUntil.bind(cfContext),
      );
    },
  }),
};
```

**Using in a WebSocket API route:**

```typescript
// src/pages/api/ws.ts
import { sandboxManager } from "../../lib/sandbox";

export const GET: APIRoute = async ({ request, url }) => {
  const sandboxId = url.searchParams.get("sandboxId");
  if (!sandboxId) return new Response("Missing sandboxId", { status: 400 });
  return sandboxManager.handleWebSocketUpgrade(request, sandboxId);
};
```

### `SandboxPreview` — Client-side WS + polling state machine

**File:** `src/lib/sandbox-preview.ts`

Framework-agnostic. Manages WebSocket connection (primary channel) with deferred polling fallback. Works with any UI layer — Alpine, React, Svelte, vanilla JS.

```typescript
import { SandboxPreview } from "./lib/sandbox-preview";

const preview = new SandboxPreview({
  // Trigger server-side init. Return { data: { status, previewUrl?, wsEndpoint? } }
  // or { error: { message } }.
  start: () => actions.startSandbox({ sandboxId, host }),

  // Check server-side status (same call, idempotent).
  poll: () => actions.startSandbox({ sandboxId, host }),

  // Optional tuning (defaults shown)
  pollFallbackDelay: 5000, // Wait 5s before activating polling
  pollInterval: 5000,       // Poll every 5s (backup only)
  wsReconnectDelay: 3000,   // Reconnect WS after 3s on close
});

// Subscribe to events — wire these to your UI framework
preview.on("progress", ({ step }) => {
  console.log("Step:", step);
});

preview.on("ready", ({ previewUrl }) => {
  document.querySelector("iframe")!.src = previewUrl;
});

preview.on("error", ({ message }) => {
  console.error("Failed:", message);
});

// Start the flow
preview.init();

// Clean up on unmount
preview.destroy();
```

**What the preview client handles for you:**

| Concern | What it does |
|---|---|
| **WebSocket primary** | Connects to the `wsEndpoint` from the start response. Auto-reconnects on close. |
| **Deferred polling** | Only activates if WS is silent after `pollFallbackDelay`. Self-cancels if WS comes alive. |
| **`wsHasDelivered` tracking** | Only counts substantive messages (progress/ready/error), not handshake acks. |
| **Terminal state cleanup** | On ready or error: closes WS, clears all timers, stops polling. |
| **Event emitter** | `on("progress" \| "ready" \| "error", handler)` returns an unsubscribe function. |
| **`destroy()`** | Full cleanup — timers, WS, listeners. Call on component unmount. |

**Example: wiring to Alpine.js** (as done in this project):

```typescript
Alpine.data("sandbox", () => ({
  state: "loading",
  statusText: "Initializing...",
  previewUrl: "",
  errorMessage: "",

  init() {
    const preview = new SandboxPreview({ start: callAction, poll: callAction });
    preview.on("progress", ({ step }) => { this.statusText = descriptions[step]; });
    preview.on("ready", ({ previewUrl }) => { this.state = "ready"; this.previewUrl = previewUrl; });
    preview.on("error", ({ message }) => { this.state = "error"; this.errorMessage = message; });
    preview.init();
  },
}));
```

**Example: wiring to React:**

```tsx
function SandboxView({ sandboxId, host }: Props) {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [previewUrl, setPreviewUrl] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const preview = new SandboxPreview({
      start: () => startSandbox(sandboxId, host),
      poll: () => startSandbox(sandboxId, host),
    });
    preview.on("ready", ({ previewUrl }) => { setState("ready"); setPreviewUrl(previewUrl); });
    preview.on("error", ({ message }) => { setState("error"); setError(message); });
    preview.init();
    return () => preview.destroy();
  }, [sandboxId, host]);

  if (state === "loading") return <Spinner />;
  if (state === "error") return <Error message={error} />;
  return <iframe src={previewUrl} />;
}
```

### How the pieces fit together

```
┌─────────────────────────────────────────────────────────────────┐
│  Your project                                                   │
│                                                                 │
│  src/lib/sandbox.ts          ← You write this (app-specific)   │
│    new SandboxManager({                                         │
│      port, token,                                               │
│      initialize: async ({ sandbox, progress }) => {             │
│        // your files, processes, health checks                  │
│      }                                                          │
│    })                                                           │
│                                                                 │
│  src/lib/sandbox-manager.ts  ← Reusable (copy or import)       │
│    State map, TTL, broadcast, recovery, WS upgrade              │
│                                                                 │
│  src/lib/sandbox-preview.ts  ← Reusable (copy or import)       │
│    WS + polling state machine, event emitter                    │
│                                                                 │
│  src/actions/index.ts        ← Thin: manager.start()           │
│  src/pages/api/ws.ts         ← Thin: manager.handleWsUpgrade() │
│  src/components/             ← Thin: SandboxPreview + your UI  │
└─────────────────────────────────────────────────────────────────┘
```

To use in a new project:

1. Copy `sandbox-manager.ts` and `sandbox-preview.ts` into your `src/lib/`
2. Create your own `sandbox.ts` that instantiates `SandboxManager` with your `initialize` callback
3. Wire the action and WS route to the manager (2-3 lines each)
4. Wire `SandboxPreview` to your UI framework of choice

---

## Why Astro v6 beta?

Astro v6 (`6.0.0-beta.13`) with `@astrojs/cloudflare@13.0.0-beta.8` significantly simplifies building on Cloudflare Workers:

- **Dev server runs on `workerd`** — not Node.js. This means `cloudflare:workers` imports, Durable Objects, and `@cloudflare/sandbox` all resolve correctly in local dev without polyfills or workarounds.
- **No `workerEntryPoint` config** — instead, set `"main": "./src/worker-entry.ts"` in `wrangler.jsonc` and use a standard Worker export pattern.
- **`import { env } from "cloudflare:workers"`** — replaces the removed `Astro.locals.runtime.env`. Access bindings directly from any server-side code.
- **`Astro.locals.cfContext`** — provides `waitUntil()` for keeping the worker alive during background async work.
- **`astro preview` works with workerd** — preview builds run in the same runtime as production.

## Architecture

Each page view gets a unique sandbox container. No two visitors share a container.

```
Browser                          Cloudflare Worker (Astro v6)
  │                                      │
  ├─ Page load ──────────────────────────►│ index.astro (SSR)
  │  (generates sandbox-${randomUUID()})  │
  │                                      │
  ├─ actions.startSandbox() ────────────►│ Astro Action (RPC)
  │  (sandboxId + host)                  │   └─ sandboxManager.start()
  │                                      │   └─ waitUntil(initPromise)
  │◄─ { status, wsEndpoint } ────────────┤
  │                                      │
  ├─ WebSocket /api/ws ─────────────────►│ API Route (upgrade)
  │◄─ progress: creating_workspace       │   └─ sandboxManager.handleWsUpgrade()
  │◄─ progress: writing_files            │
  │◄─ progress: starting_server          │
  │◄─ progress: waiting_for_ready        │
  │◄─ progress: exposing_port            │
  │◄─ ready: { previewUrl }              │
  │                                      │
  │  [polling fallback if WS silent 5s]  │
  │                                      │
  ├─ <iframe src={previewUrl}> ──────────►│ Astro Middleware
  │                                      │   └─ proxyToSandbox()
  │                                      │       └─ Sandbox Container
  │◄─ Express.js JSON response ──────────┤           └─ Port 3001
```

### Data flow

1. **Page load** — Astro SSR renders `index.astro`, generating a unique `sandboxId` via `crypto.randomUUID()`
2. **Astro Action** — Client calls `actions.startSandbox({ sandboxId, host })` (type-safe RPC). The action calls `sandboxManager.start()` which accesses the `Sandbox` Durable Object binding and kicks off initialization with `waitUntil()`.
3. **WebSocket (primary)** — Client's `SandboxPreview` connects to `/api/ws?sandboxId=...` for real-time progress. The manager broadcasts initialization steps to all connected clients.
4. **Polling (deferred fallback)** — If WebSocket is silent after 5 seconds (broadcasts from `waitUntil` don't always reach clients), `SandboxPreview` activates polling as a backup. Self-cancels if WS comes alive.
5. **Ready** — Once the Express server is healthy and the port is exposed, a `ready` message with the preview URL is broadcast.
6. **Preview** — The component shows an iframe. Requests to the preview URL subdomain (`3001-{sandboxId}-express.sandbox.cfsa.dev`) hit Astro middleware, which calls `proxyToSandbox()` to route them to the correct container.

### Container lifecycle

Each container has a 5-minute TTL managed by `SandboxManager`. Active users keep the container alive via `touch()` on every status check. When the TTL expires, `sandbox.destroy()` kills the container and frees the instance slot.

```
Page load → init → container starts → ready
  ↓
touch() → scheduleDestroy(5min)
  ↓
Each poll/status check → touch() → timer reset
  ↓
User leaves → 5min → destroySandbox() → container killed
  ↓
Safety net: sleepAfter:"5m" at DO level (covers isolate eviction)
```

The `setTimeout` lives in the Worker isolate. If the isolate is evicted (~30s of no requests), the timer is lost. The `sleepAfter` on `getSandbox()` is a belt-and-suspenders fallback — the container auto-sleeps at the DO level.

## Project structure

```
.
├── package.json                    # Dependencies (Astro v6 beta, Sandbox SDK, Alpine.js)
├── astro.config.mjs                # Astro config with Cloudflare adapter
├── wrangler.jsonc                  # Worker, DO, containers (max_instances:5), routes
├── worker-configuration.d.ts       # Auto-generated types (wrangler types)
├── tsconfig.json
├── sandbox/
│   ├── Dockerfile                  # cloudflare/sandbox:0.7.4 base + Node 22 + pnpm
│   └── express-app/
│       ├── package.json            # Express dependency
│       ├── pnpm-lock.yaml
│       └── server.js               # Pre-installed Express server (port 3001)
└── src/
    ├── worker-entry.ts             # Custom Worker entry: exports Sandbox DO + Astro handler
    ├── middleware.ts                # proxyToSandbox() — routes preview URL requests to containers
    ├── env.d.ts                    # Astro type declarations
    ├── lib/
    │   ├── sandbox-manager.ts      # ★ Reusable: server-side lifecycle manager
    │   ├── sandbox-preview.ts      # ★ Reusable: client-side WS + polling state machine
    │   └── sandbox.ts              # App-specific: SandboxManager instance with Express init
    ├── actions/
    │   └── index.ts                # Astro action: sandboxManager.start() (thin wrapper)
    ├── components/
    │   └── SandboxComponent.astro  # Alpine.js UI + SandboxPreview bindings
    └── pages/
        ├── index.astro             # Main page (unique sandboxId per view)
        └── api/
            └── ws.ts               # WebSocket endpoint (thin: manager.handleWsUpgrade())
```

## Key implementation details

### Custom Worker entry (`src/worker-entry.ts`)

Astro v6 requires a custom entry point to export Durable Object classes alongside the Astro handler:

```typescript
import handler from "@astrojs/cloudflare/entrypoints/server";
import { Sandbox } from "@cloudflare/sandbox";

export { Sandbox };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return handler.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
```

### Astro middleware for preview URL routing (`src/middleware.ts`)

Sandbox preview URLs use subdomain-based routing (e.g. `3001-sandbox-id-express.sandbox.cfsa.dev`). When the browser loads the iframe, that request hits the same Worker but with a different `Host` header. Without intervention, Astro would route it as a normal page.

The `proxyToSandbox()` function inspects the request hostname, determines if it matches a preview URL pattern, and proxies the request to the correct sandbox container. It returns `null` for non-preview requests so normal Astro routing continues.

The middleware uses `instanceof Response` to guard against `proxyToSandbox()` returning truthy non-Response objects (e.g. proxy stubs), which would serialize as `"[object Object]"`:

```typescript
export const onRequest = defineMiddleware(async ({ request }, next) => {
  const { Sandbox } = env as Env;
  if (Sandbox) {
    try {
      const { proxyToSandbox } = await import("@cloudflare/sandbox");
      const proxyResponse = await proxyToSandbox(request, env as any);
      if (proxyResponse instanceof Response) return proxyResponse;
    } catch (err) {
      console.error("[middleware] proxyToSandbox error:", err);
    }
  }
  return next();
});
```

### `waitUntil` is required

Fire-and-forget async functions get killed by workerd. The sandbox initialization is long-running (~5-10s in production, up to 40s in dev), so `waitUntil()` from `Astro.locals.cfContext` keeps the worker alive.

### Dynamic import for `@cloudflare/sandbox`

Top-level `import { getSandbox } from "@cloudflare/sandbox"` fails in Astro API routes and actions. Use dynamic import inside the handler:

```typescript
const { getSandbox } = await import("@cloudflare/sandbox");
```

### Containers config must be at top level in `wrangler.jsonc`

The `containers` array must be in the top-level config (not only in `env.production`) for local dev to build and run the Docker container.

## Prerequisites

- Node.js 18+
- pnpm
- Docker (for local development — containers run in Docker locally)
- Cloudflare account with custom domain (for deployment)

## Getting started

```bash
# Install dependencies
pnpm install

# Start dev server (generates types, builds container, starts workerd)
pnpm dev
```

The dev server starts at `http://localhost:4321`. On first page load:

1. The Astro action triggers sandbox initialization
2. WebSocket streams progress (creating workspace, writing files, starting server...)
3. Once ready, an iframe shows the Express.js JSON response from the sandbox container

## Deployment

### DNS setup

Sandbox preview URLs require wildcard DNS. Configure in Cloudflare DNS dashboard:

| Type  | Name               | Target                |
|-------|--------------------|-----------------------|
| CNAME | sandbox            | sandbox.cfsa.dev      |
| CNAME | *.sandbox          | sandbox.cfsa.dev      |

### Routes

The worker is attached to two routes in `wrangler.jsonc`:

```jsonc
"routes": [
  { "pattern": "sandbox.cfsa.dev", "custom_domain": true },
  { "pattern": "*.sandbox.cfsa.dev/*", "zone_name": "cfsa.dev" }
]
```

The first serves the main page. The second catches preview URL subdomains so `proxyToSandbox()` can route them to the correct container.

### Deploy command

```bash
pnpm deploy
# Runs: wrangler types && astro build && wrangler deploy
```

`astro build` now carries `routes` and `workers_dev` into `dist/server/wrangler.json`, so the deploy flow no longer needs post-build patching.

## Scripts

| Script         | Description                                          |
| -------------- | ---------------------------------------------------- |
| `pnpm dev`     | Generate types + start Astro dev server (workerd)    |
| `pnpm build`   | Generate types + build for production                |
| `pnpm preview` | Preview production build locally (workerd)           |
| `pnpm types`   | Regenerate `worker-configuration.d.ts`               |
| `pnpm deploy`  | Build + deploy to Cloudflare (production)            |

## Known issues and workarounds

### `[object Object]` response body (critical)

A known Astro + Cloudflare adapter bug ([withastro/astro#14511](https://github.com/withastro/astro/issues/14511)). With `nodejs_compat`, workerd exposes native `process` v2, making Astro think it's Node.js and return AsyncIterable response bodies. workerd's `Response` constructor doesn't support AsyncIterable, so the body gets coerced to `"[object Object]"`.

**Fix:** Add `disable_nodejs_process_v2` to compatibility flags. This prevents Astro from misdetecting the runtime in both dev and production:

```jsonc
"compatibility_flags": ["nodejs_compat", "disable_nodejs_process_v2"]
```

The `fetch_iterable_type_support` flag (auto-enabled at compat date `2026-02-19`) patches the symptom on the workerd side, but doesn't fix dev due to a chunk evaluation ordering issue where Astro's `isNode` check runs before the process polyfill is applied. `disable_nodejs_process_v2` attacks the root cause.

### WebSocket broadcasts from `waitUntil` are unreliable

Broadcasts from `waitUntil` don't always reach WebSocket clients (cross-I/O-context issue in workerd). The `SandboxPreview` client has a deferred polling fallback that activates after 5 seconds of WS silence. This is a known limitation, not a bug in this codebase.

### `proxyToSandbox()` can return non-Response truthy values

The middleware guards with `instanceof Response` and wraps in try/catch. Without this, Astro would serialize the return value as `"[object Object]"`.

## Troubleshooting

### "Connection refused: container port not found"

Normal on first startup — the container takes a moment to boot. The health check retries automatically (up to 10 attempts, 2s apart).

### Preview URL returns 404 or the main page HTML

Ensure wildcard DNS is configured (`*.sandbox.cfsa.dev` CNAME). Without it, preview URL requests route to Astro's normal pages instead of `proxyToSandbox()`.

### "Maximum number of running container instances exceeded"

Stale containers from previous page views are occupying all `max_instances` slots. Containers auto-destroy after 5 minutes of inactivity. Wait, or increase `max_instances` in `wrangler.jsonc`. Current setting: 5.

### "Durable Object reset because its code was updated"

Expected noise in logs after deploys. Old DOs from previous sandbox IDs receive code updates and log errors. They self-resolve as old containers expire.

### `PortAlreadyExposedError` in logs

The container persisted across an isolate eviction or deploy. The `SandboxManager` handles this automatically — it detects the already-exposed port via `getExposedPorts()` and skips to "ready". If you see this error looping, check that the recovery path is working (look for "Container already has port 3001 exposed" in logs).

## Key discoveries

### Port 3000 is reserved

The Sandbox SDK reserves port 3000 for its internal Bun server. Always use a different port (this example uses 3001).

### Version matching

The SDK package and Docker base image versions must match:

```
@cloudflare/sandbox@0.7.4  ←→  docker.io/cloudflare/sandbox:0.7.4
```

### `normalizeId: true` required

Preview URLs extract the sandbox ID from the hostname, which is always lowercased (per RFC 3986). The `SandboxManager` passes `normalizeId: true` to `getSandbox()` automatically.

### Local dev vs production

| Aspect          | Local (`astro dev`)                                            | Production (`wrangler deploy`)                     |
| --------------- | -------------------------------------------------------------- | -------------------------------------------------- |
| **Runtime**     | workerd (same as production)                                   | workerd                                            |
| **Port**        | 4321 (Astro default)                                           | N/A                                                |
| **Preview URL** | `http://3001-{id}-express.localhost:4321/`                     | `https://3001-{id}-express.sandbox.cfsa.dev/`      |
| **Containers**  | Docker (built automatically on dev start)                      | Cloudflare managed                                 |
| **SSL**         | HTTP                                                           | HTTPS automatic                                    |
| **Init time**   | 30-40s (Docker build + npm)                                    | ~5-10s (pre-built image)                           |

## Decisions log

All architectural decisions and problems solved are documented in [`_plan/4. decisions.md`](./_plan/4.%20decisions.md) (25 decisions).

## Resources

- [Cloudflare Sandbox SDK Docs](https://developers.cloudflare.com/sandbox/)
- [Astro v6 Cloudflare Adapter](https://docs.astro.build/en/guides/integrations-guide/cloudflare/)
- [Cloudflare Containers](https://developers.cloudflare.com/containers/)
- [Astro Actions](https://docs.astro.build/en/guides/actions/)
- [withastro/astro#14511](https://github.com/withastro/astro/issues/14511) — `[object Object]` response bug
