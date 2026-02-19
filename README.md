# Cloudflare Sandbox SDK Minimal Example

A working demonstration of Cloudflare's Sandbox SDK using **Astro v6 beta** with the Cloudflare adapter. Runs an Express.js server inside an isolated container with real-time WebSocket progress updates during initialization.

## Why Astro v6 beta?

Astro v6 (`6.0.0-beta.13`) with `@astrojs/cloudflare` v13 beta significantly simplifies building on Cloudflare Workers:

- **Dev server runs on `workerd`** — not Node.js. This means `cloudflare:workers` imports, Durable Objects, and `@cloudflare/sandbox` all resolve correctly in local dev without polyfills or workarounds.
- **No `workerEntryPoint` config** — instead, set `"main": "./src/worker-entry.ts"` in `wrangler.jsonc` and use a standard Worker export pattern.
- **`import { env } from "cloudflare:workers"`** — replaces the removed `Astro.locals.runtime.env`. Access bindings directly from any server-side code.
- **`Astro.locals.cfContext`** — provides `waitUntil()` for keeping the worker alive during background async work.
- **`astro preview` works with workerd** — preview builds run in the same runtime as production.

## Architecture

```
Browser                          Cloudflare Worker (Astro v6)
  │                                      │
  ├─ Page load ──────────────────────────►│ index.astro (SSR)
  │                                      │
  ├─ actions.startSandbox() ────────────►│ Astro Action (RPC)
  │  (type-safe, auto-serialized)        │   └─ env.Sandbox DO binding
  │                                      │   └─ waitUntil(initPromise)
  │◄─ { status, wsEndpoint } ────────────┤
  │                                      │
  ├─ WebSocket /api/ws ─────────────────►│ API Route (upgrade)
  │◄─ progress: creating_workspace       │   └─ shared module state
  │◄─ progress: installing_dependencies  │
  │◄─ progress: starting_server          │
  │◄─ ready: { previewUrl }              │
  │                                      │
  ├─ <iframe src={previewUrl}> ──────────►│ Sandbox Container
  │◄─ Express.js JSON response ──────────┤   └─ Port 3001 exposed
```

### Data flow

1. **Page load** — Astro SSR renders `index.astro` with `SandboxComponent`
2. **Astro Action** — Client calls `actions.startSandbox()` (type-safe RPC). The action accesses the `Sandbox` Durable Object binding via `cloudflare:workers` env and kicks off initialization with `waitUntil()`.
3. **WebSocket** — Client connects to `/api/ws` for real-time progress. The WebSocket route and the action share module-level state (`src/lib/sandbox.ts`) so the WS handler can relay initialization progress.
4. **Ready** — Once the Express server is healthy and the port is exposed, a `ready` message with the preview URL is broadcast to all connected WebSocket clients.
5. **Preview** — The component shows an iframe pointing to the sandbox preview URL.

## Project structure

```
.
├── package.json                    # Dependencies (Astro v6 beta, Sandbox SDK)
├── astro.config.mjs                # Astro config with Cloudflare adapter
├── wrangler.jsonc                  # Worker, DO, containers, service bindings
├── worker-configuration.d.ts       # Auto-generated types (wrangler types)
├── tsconfig.json
├── sandbox/
│   ├── Dockerfile                  # Container: cloudflare/sandbox base + Node 22
│   └── express-app/
│       ├── package.json
│       ├── pnpm-lock.yaml
│       └── server.js               # Pre-installed Express server
└── src/
    ├── worker-entry.ts             # Custom Worker entry: exports Sandbox DO + Astro handler
    ├── middleware.ts                # proxyToSandbox() — routes preview URL requests to containers
    ├── env.d.ts                    # Astro type declarations
    ├── lib/
    │   └── sandbox.ts              # Shared sandbox state, init logic, WebSocket broadcast
    ├── actions/
    │   └── index.ts                # Astro action: startSandbox (RPC)
    ├── components/
    │   └── SandboxComponent.astro  # UI: calls action, connects WS, shows iframe
    └── pages/
        ├── index.astro             # Main page
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

Sandbox preview URLs use subdomain-based routing (e.g. `http://3001-sandbox-id-token.localhost:4321/`). When the browser loads the iframe, that request hits the same Astro server but with a different `Host` header. Without intervention, Astro would try to route it as a normal page and return a 404 or the wrong content.

The `proxyToSandbox()` function from `@cloudflare/sandbox` inspects the request hostname, determines if it matches a preview URL pattern, and proxies the request to the correct sandbox container. It returns `null` for non-preview requests so normal Astro routing continues.

Astro middleware (`src/middleware.ts`) is the right place for this because it intercepts **every** request before pages, actions, or API routes are evaluated — exactly the "call `proxyToSandbox()` first" pattern the [Sandbox SDK docs](https://developers.cloudflare.com/sandbox/concepts/preview-urls/) require:

```typescript
import { defineMiddleware } from "astro:middleware";
import { env } from "cloudflare:workers";

export const onRequest = defineMiddleware(async ({ request }, next) => {
  const { Sandbox } = env as Env;

  if (Sandbox) {
    const { proxyToSandbox } = await import("@cloudflare/sandbox");
    const proxyResponse = await proxyToSandbox(request, env as any);
    if (proxyResponse) return proxyResponse;
  }

  return next();
});
```

### Astro Actions for type-safe RPC (`src/actions/index.ts`)

Actions use `cloudflare:workers` to access bindings — the Astro v6 Cloudflare adapter removed `locals.runtime.env` in favor of this pattern. The `Env` type comes from `worker-configuration.d.ts` (auto-generated by `wrangler types`):

```typescript
import { env } from "cloudflare:workers";
import { startSandbox } from "../lib/sandbox";

export const server = {
  startSandbox: defineAction({
    input: z.object({ host: z.string() }),
    handler: async (input, context) => {
      const { cfContext } = context.locals;
      const { Sandbox } = env as Env;
      return startSandbox(input.host, Sandbox, cfContext.waitUntil.bind(cfContext));
    },
  }),
};
```

### `waitUntil` is required

Fire-and-forget async functions get killed by workerd. The sandbox initialization is long-running (npm install, server startup, health checks), so `waitUntil()` from `Astro.locals.cfContext` keeps the worker alive:

```typescript
const initPromise = initializeSandbox(host, sandboxBinding);
if (waitUntil) {
  waitUntil(initPromise);
}
```

### Dynamic import for `@cloudflare/sandbox`

Top-level `import { getSandbox } from "@cloudflare/sandbox"` fails in Astro API routes and actions. Use dynamic import inside the handler:

```typescript
const { getSandbox } = await import("@cloudflare/sandbox");
```

### Containers config must be at top level in `wrangler.jsonc`

The `containers` array must be in the top-level config (not only in `env.production`) for local dev to build and run the Docker container. Astro v6's workerd dev server handles this correctly.

## Prerequisites

- Node.js 18+
- pnpm
- Docker (for local development — containers run in Docker locally)
- Cloudflare account (for deployment)

## Getting started

```bash
# Install dependencies
pnpm install

# Start dev server (generates types, builds container, starts workerd)
pnpm dev
```

The dev server starts at `http://localhost:4321`. On first page load:

1. The Astro action triggers sandbox initialization
2. WebSocket streams progress (creating workspace, installing deps, starting server...)
3. Once ready, an iframe shows the Express.js response from the sandbox container

## Scripts

| Script         | Description                                          |
| -------------- | ---------------------------------------------------- |
| `pnpm dev`     | Generate types + start Astro dev server (workerd)    |
| `pnpm build`   | Generate types + build for production                |
| `pnpm preview` | Preview production build locally (workerd)           |
| `pnpm types`   | Regenerate `worker-configuration.d.ts`               |
| `pnpm deploy`  | Build + deploy to Cloudflare (production env)        |

## Key discoveries

### Local dev hostname

In local dev, `exposePort()` receives the host from `Astro.url.host` (e.g. `localhost:4321`). The SDK returns a preview URL like `http://3001-minimal-example-sandbox-express.localhost:4321/`.

### Port 3000 is reserved

The Sandbox SDK reserves port 3000 for its internal Bun server. Always use a different port (this example uses 3001).

### Version matching

The SDK package and Docker base image versions must match:

```
@cloudflare/sandbox@0.7.4  ←→  docker.io/cloudflare/sandbox:0.7.4
```

### Local dev vs production

| Aspect          | Local (`astro dev`)                                            | Production (`wrangler deploy`)               |
| --------------- | -------------------------------------------------------------- | -------------------------------------------- |
| **Runtime**     | workerd (same as production)                                   | workerd                                      |
| **Port**        | 4321 (Astro default)                                           | N/A                                          |
| **Preview URL** | `http://3001-{id}-{token}.localhost:4321/`                     | `https://3001-{id}-{token}.yourdomain.com`   |
| **Containers**  | Docker (built automatically on dev start)                      | Cloudflare managed                           |
| **SSL**         | HTTP                                                           | HTTPS automatic                              |

## Troubleshooting

### "Connection refused: container port not found"

This is normal on first startup — the container takes a moment to boot. The SDK retries automatically and logs "Port 3000 is ready" once the container is up.

### "Build ID should be set if containers are defined"

This happened when `containers` was in the top-level config with older Astro/wrangler versions. With Astro v6 beta + wrangler 4.66+, containers at top level works correctly in dev.

### Preview URL returns 404

Ensure the hostname passed to `exposePort()` includes the port in local dev. This example uses `Astro.url.host` which includes the port automatically.

### "Preview URLs require lowercase sandbox IDs"

Use `normalizeId: true` in `getSandbox()`:

```typescript
const sandbox = getSandbox(binding, "my-sandbox-name", { normalizeId: true });
```

## Resources

- [Cloudflare Sandbox SDK Docs](https://developers.cloudflare.com/sandbox/)
- [Astro v6 Cloudflare Adapter](https://docs.astro.build/en/guides/integrations-guide/cloudflare/)
- [Cloudflare Containers](https://developers.cloudflare.com/containers/)
