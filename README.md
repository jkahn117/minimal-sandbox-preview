# Cloudflare Sandbox SDK Minimal Example

A working demonstration of Cloudflare's Sandbox SDK using **Astro v6 beta** with the Cloudflare adapter. Runs an Express.js server inside an isolated container with real-time WebSocket progress updates during initialization.

Live at: **https://sandbox.cfsa.dev**

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
  │  (sandboxId + host)                  │   └─ env.Sandbox DO binding
  │                                      │   └─ waitUntil(initPromise)
  │◄─ { status, wsEndpoint } ────────────┤
  │                                      │
  ├─ WebSocket /api/ws ─────────────────►│ API Route (upgrade)
  │◄─ progress: creating_workspace       │   └─ shared module state
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
2. **Astro Action** — Client calls `actions.startSandbox({ sandboxId, host })` (type-safe RPC). The action accesses the `Sandbox` Durable Object binding via `cloudflare:workers` env and kicks off initialization with `waitUntil()`.
3. **WebSocket (primary)** — Client connects to `/api/ws?sandboxId=...` for real-time progress. The WebSocket route and the action share module-level state (`src/lib/sandbox.ts`) so the WS handler can relay initialization progress.
4. **Polling (deferred fallback)** — If WebSocket is silent after 5 seconds (broadcasts from `waitUntil` don't always reach clients), polling activates as a backup. Self-cancels if WS comes alive.
5. **Ready** — Once the Express server is healthy and the port is exposed, a `ready` message with the preview URL is broadcast to all connected WebSocket clients.
6. **Preview** — The component shows an iframe. Requests to the preview URL subdomain (`3001-{sandboxId}-express.sandbox.cfsa.dev`) hit Astro middleware, which calls `proxyToSandbox()` to route them to the correct container.

### Container lifecycle

Each container has a 5-minute TTL. Active users keep the container alive via `touchSandbox()` on every status check. When the TTL expires, `sandbox.destroy()` kills the container and frees the instance slot.

```
Page load → init → container starts → ready
  ↓
touchSandbox() → scheduleDestroy(5min)
  ↓
Each poll/status check → touchSandbox() → timer reset
  ↓
User leaves → 5min → destroySandbox() → container killed
  ↓
Safety net: sleepAfter:"5m" at DO level (covers isolate eviction)
```

The `setTimeout` lives in the Worker isolate. If the isolate is evicted (~30s of no requests), the timer is lost. The `sleepAfter: "5m"` on `getSandbox()` is a belt-and-suspenders fallback — the container auto-sleeps at the DO level.

## Project structure

```
.
├── package.json                    # Dependencies (Astro v6 beta, Sandbox SDK, Zod v4)
├── astro.config.mjs                # Astro config with Cloudflare adapter
├── wrangler.jsonc                  # Worker, DO, containers (max_instances:5), routes
├── worker-configuration.d.ts       # Auto-generated types (wrangler types)
├── tsconfig.json
├── scripts/
│   └── patch-deploy-config.mjs     # Post-build: injects routes/workers_dev into deploy config
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
    │   └── sandbox.ts              # Per-sandboxId state Map, init, TTL cleanup, WS broadcast
    ├── actions/
    │   └── index.ts                # Astro action: startSandbox (RPC, type-safe)
    ├── components/
    │   └── SandboxComponent.astro  # UI: WS-primary + deferred polling fallback + iframe
    └── pages/
        ├── index.astro             # Main page (unique sandboxId per view)
        └── api/
            └── ws.ts               # WebSocket endpoint for progress updates
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

### Astro Actions for type-safe RPC (`src/actions/index.ts`)

The action accepts both `sandboxId` and `host`, uses `cloudflare:workers` for env access, and passes `waitUntil` to keep the init promise alive:

```typescript
export const server = {
  startSandbox: defineAction({
    input: z.object({ sandboxId: z.string(), host: z.string() }),
    handler: async (input, context) => {
      const { cfContext } = context.locals;
      const waitUntil = cfContext.waitUntil.bind(cfContext);
      const { Sandbox } = env as Env;
      return startSandbox(input.sandboxId, input.host, Sandbox, waitUntil);
    },
  }),
};
```

### `waitUntil` is required

Fire-and-forget async functions get killed by workerd. The sandbox initialization is long-running (~5-10s in production, up to 40s in dev), so `waitUntil()` from `Astro.locals.cfContext` keeps the worker alive.

### Dynamic import for `@cloudflare/sandbox`

Top-level `import { getSandbox } from "@cloudflare/sandbox"` fails in Astro API routes and actions. Use dynamic import inside the handler:

```typescript
const { getSandbox } = await import("@cloudflare/sandbox");
```

### Isolate eviction recovery

Worker isolates can be evicted after ~30s of no requests or on deploy, losing the in-memory state `Map`. But the container keeps running. On the next request, `initializeSandbox()` calls `sandbox.getExposedPorts()` first — if port 3001 is already exposed, it skips the full init and goes straight to "ready". This prevents `PortAlreadyExposedError` loops and avoids redundant work on an already-running container.

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
# Runs: wrangler types && astro build && node scripts/patch-deploy-config.mjs && wrangler deploy
```

The post-build patch (`scripts/patch-deploy-config.mjs`) is necessary because `astro build` generates `dist/server/wrangler.json` which wrangler uses for deploy, but the Astro adapter **drops `routes` and `workers_dev`** from the generated config. Without the patch, the worker deploys but isn't attached to the custom domain.

## Scripts

| Script         | Description                                          |
| -------------- | ---------------------------------------------------- |
| `pnpm dev`     | Generate types + start Astro dev server (workerd)    |
| `pnpm build`   | Generate types + build for production                |
| `pnpm preview` | Preview production build locally (workerd)           |
| `pnpm types`   | Regenerate `worker-configuration.d.ts`               |
| `pnpm deploy`  | Build + patch + deploy to Cloudflare (production)    |

## Known issues and workarounds

### `[object Object]` response body (critical)

A known Astro + Cloudflare adapter bug ([withastro/astro#14511](https://github.com/withastro/astro/issues/14511)). With `nodejs_compat`, workerd exposes native `process` v2, making Astro think it's Node.js and return AsyncIterable response bodies. workerd's `Response` constructor doesn't support AsyncIterable, so the body gets coerced to `"[object Object]"`.

**Fix:** Enable `fetch_iterable_type_support` compatibility flag (auto-enables at compat date `2026-02-19`):

```jsonc
"compatibility_date": "2026-02-19",
"compatibility_flags": ["nodejs_compat"]
```

Alternative: `disable_nodejs_process_v2` flag prevents Astro from detecting Node.js in the first place.

### WebSocket broadcasts from `waitUntil` are unreliable

Broadcasts from `waitUntil` don't always reach WebSocket clients (cross-I/O-context issue in workerd). The client has a deferred polling fallback that activates after 5 seconds of WS silence. This is a known limitation, not a bug in this codebase.

### Post-build config patching

The Astro Cloudflare adapter drops `routes` and `workers_dev` from the generated deploy config. The `scripts/patch-deploy-config.mjs` script injects them back after `astro build`. This is fragile — revisit when Astro v6 reaches GA.

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

The container persisted across an isolate eviction or deploy. The `getExposedPorts()` recovery check at the top of `initializeSandbox()` handles this — it detects the already-exposed port and skips to "ready". If you see this error looping, check that the recovery path is working (look for "Container already has port 3001 exposed" in logs).

### LSP errors in `src/worker/index.ts` or `astro:actions`

Ghost errors from stale caches or virtual modules. Run `pnpm types` and restart your editor. The `src/worker/index.ts` file was removed (replaced by `src/worker-entry.ts`).

## Key discoveries

### Port 3000 is reserved

The Sandbox SDK reserves port 3000 for its internal Bun server. Always use a different port (this example uses 3001).

### Version matching

The SDK package and Docker base image versions must match:

```
@cloudflare/sandbox@0.7.4  ←→  docker.io/cloudflare/sandbox:0.7.4
```

### `normalizeId: true` required

Preview URLs extract the sandbox ID from the hostname, which is always lowercased (per RFC 3986). Pass `normalizeId: true` to `getSandbox()` so the DO ID matches.

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

All architectural decisions and problems solved are documented in [`_plan/4. decisions.md`](./_plan/4.%20decisions.md) (22 decisions).

## Resources

- [Cloudflare Sandbox SDK Docs](https://developers.cloudflare.com/sandbox/)
- [Astro v6 Cloudflare Adapter](https://docs.astro.build/en/guides/integrations-guide/cloudflare/)
- [Cloudflare Containers](https://developers.cloudflare.com/containers/)
- [Astro Actions](https://docs.astro.build/en/guides/actions/)
- [withastro/astro#14511](https://github.com/withastro/astro/issues/14511) — `[object Object]` response bug
