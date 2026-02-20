# Running Express Inside a Cloudflare Worker: A Sandbox SDK Build Log

Cloudflare's Sandbox SDK lets you spin up an isolated Linux container from
inside a Worker and run arbitrary code in it. An Express server, a Python
script, a full dev environment — whatever fits in a Docker image. The
container gets its own filesystem, processes, and network. The Worker
orchestrates it.

I built a minimal example to understand what that actually means in
practice: a single Astro page that boots an Express server inside a
Sandbox container, streams initialization progress to the browser, and
embeds the running server in an iframe. The idea was simple. Getting
there was not.

This is the story of the decisions, dead ends, and workarounds that
shaped the final implementation.

---

## The goal

One page. You load it, it creates a sandbox container, writes an Express
app into it, starts the server, exposes a port, and shows you the result
in an iframe. The Express server responds with a JSON payload. That's
it.

The point wasn't to build something useful — it was to map the terrain.
Where does `@cloudflare/sandbox` fit in the Worker lifecycle? What
breaks locally that works in production and vice versa? What happens
when the isolate gets evicted? How do you know when the container is
ready?

## Starting point: the plan that didn't survive contact

The original design had a Hono router handling everything — API
endpoints, WebSocket connections, a `proxyToSandbox` middleware, and an
HTML response with an embedded iframe. A single shared sandbox ID. No
cleanup strategy. The Astro frontend was an afterthought, a static page
that redirected to the Worker.

Almost none of this survived.

## Decision 1: Astro v6 beta, because dev has to match production

The first wall was local development. Astro v5 with the Cloudflare
adapter v12 runs its dev server on Node.js. This means
`cloudflare:workers` imports fail. Durable Object bindings don't exist.
`@cloudflare/sandbox` can't resolve. You're building a Cloudflare Worker
app where the entire runtime is unavailable in dev.

Astro v6 beta (with adapter v13 beta) runs the dev server on workerd via
Miniflare. Same runtime as production. `import { env } from
"cloudflare:workers"` works. The Sandbox SDK resolves. Containers build
from Docker on startup.

The trade-off is obvious — beta software, API surface may change — but
the alternative was maintaining two different code paths or giving up on
local dev entirely. That's not a trade-off, it's a dead end.

## Decision 2: Drop Hono, use Astro all the way down

With Astro v6 running on workerd, the framework handles routing natively.
Astro middleware intercepts requests before pages, actions, and API
routes — exactly where `proxyToSandbox` needs to run. Astro Actions
provide type-safe RPC with automatic serialization — a better
`POST /api/start` than anything Hono would give you. The WebSocket
endpoint stays as a standard API route because Actions can't handle
upgrade requests.

Hono was adding a layer without earning it. Every route it served had an
Astro-native equivalent with better integration. It was removed.

| Hono responsibility      | Replaced by                         |
|--------------------------|-------------------------------------|
| `proxyToSandbox` mw      | Astro middleware (`src/middleware.ts`) |
| `POST /api/start`         | Astro Action (`actions.startSandbox`) |
| `GET /ws`                  | Astro API route (`src/pages/api/ws.ts`) |
| HTML response              | Astro page (`src/pages/index.astro`)  |

## Decision 3: The worker entry is a thin shim

Astro v6 removed the `workerEntryPoint` adapter option. Instead, you set
`"main"` in `wrangler.jsonc` and write a minimal entry that imports the
Astro handler and re-exports anything Workers needs to see — in this
case, the `Sandbox` Durable Object class:

```typescript
import handler from "@astrojs/cloudflare/entrypoints/server";
import { Sandbox } from "@cloudflare/sandbox";

export { Sandbox };

export default {
  async fetch(request, env, ctx) {
    return handler.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
```

Seven lines of meaningful code. Everything else lives inside Astro's
request pipeline.

## The 30-second initialization problem

Sandbox initialization takes time. Creating a workspace directory,
writing files, starting a process, waiting for a health check, exposing
a port — the full sequence runs 5-30 seconds depending on whether
dependencies are pre-installed.

This creates two problems: the Worker has to stay alive long enough to
finish, and the client has to know when it's done.

### Keeping the Worker alive: `waitUntil`

Workers kill async work that outlives the response. If you fire off
`initializeSandbox()` and return an HTTP response, the initialization
promise gets terminated. `waitUntil` keeps the isolate alive for the
duration of the promise:

```typescript
const { cfContext } = context.locals;
cfContext.waitUntil(initializeSandbox(sandboxId, host, sandboxBinding));
```

The action returns immediately with `{ status: "initializing" }`. The
real work continues in the background.

### Telling the client: WebSocket primary, polling fallback

The client needs to track progress. Two channels:

**WebSocket** connects to `/api/ws?sandboxId=...` and receives
step-by-step broadcasts from the initialization code — "creating
workspace", "writing files", "starting server", "exposing port", then
finally "ready" with the preview URL. This is the preferred path.

**Polling** calls `actions.startSandbox()` every 5 seconds to check
server-side state. It only activates if the WebSocket hasn't delivered
any message after 5 seconds.

Why both? Because WebSocket broadcasts from `waitUntil` don't reliably
reach clients. The init runs in a detached promise (kept alive by
`waitUntil`), and the WS connections are registered in a different
request context. In workerd, these I/O contexts don't always
communicate. The WS messages sometimes simply never arrive.

The polling fallback went through several iterations:

**Version 1** polled every 3 seconds immediately alongside WebSocket.
This caused duplicate paired POST requests — the initial action call
takes ~3 seconds, and the first poll tick fires nearly simultaneously.
With `max_instances: 5`, this traffic was wasteful.

**Version 2** deferred polling behind a 5-second grace period. If
WebSocket delivers anything substantive (progress, ready, or error) in
that window, polling never starts. If WebSocket comes alive after
polling has started, the next poll tick sees the flag and self-cancels.

A subtle bug in version 2 nearly derailed the whole approach: the
WebSocket route originally sent a `{ type: "connected" }` acknowledgment
on connection. The client counted this as "WebSocket is working" and
suppressed polling. But the "connected" message didn't carry any init
state — it was just a handshake. The actual progress broadcasts from
`waitUntil` often never arrived. The client would sit on
"Initializing..." forever: WS appeared alive (because of the ack),
polling was suppressed (because `wsHasDelivered` was true), and no
progress ever reached the browser.

The fix: remove the "connected" ack entirely, and only count `progress`,
`ready`, and `error` messages as evidence that WebSocket is delivering
real data.

## Container lifecycle: the cleanup problem

Each page view generates a unique sandbox ID
(`sandbox-${crypto.randomUUID()}`), which maps to a unique Durable
Object and container. Without cleanup, every page load, every browser
refresh, every HMR cycle creates a new container that lives forever.
With `max_instances: 5`, you hit the ceiling fast.

The solution is a two-layer TTL:

**Layer 1: JS-level timer.** Each sandbox state holds a `setTimeout`
handle. `touchSandbox()` resets it on every client interaction (action
calls, status checks). After 5 minutes of silence, `destroySandbox()`
calls `sandbox.destroy()` — killing the container, freeing processes,
closing ports — and removes the entry from the in-memory Map.

**Layer 2: SDK-level `sleepAfter`.** Passed to `getSandbox()` as a
safety net. If the Worker isolate is evicted before the JS timer fires
(isolates can be killed after 30 seconds of no requests), the container
still auto-sleeps after 5 minutes of inactivity on its own.

The JS timer is the primary mechanism. `sleepAfter` is the
belt-and-suspenders fallback for isolate eviction. A more robust
approach would use Durable Object alarms, but the Sandbox SDK provides
its own DO class — you can't add custom alarm handlers to it.

## The isolate eviction recovery problem

This was the most insidious bug. Here's the sequence:

1. Page loads, initialization succeeds, Express server is running, port
   3001 is exposed. Everything works.
2. The Worker isolate gets evicted (deploy, inactivity, or code update).
3. A new isolate starts with an empty `sandboxes` Map. No memory that
   the container exists.
4. The client's polling fallback hits the fresh isolate.
   `startSandbox()` sees no state and kicks off `initializeSandbox()`
   from scratch.
5. The initialization tries to `exposePort(3001)` — but it's already
   exposed from step 1. `PortAlreadyExposedError`.
6. The error gets stored. The next poll tick sees the error, resets it,
   and retries. Step 5 repeats. Infinite loop.

Meanwhile, the container is performing redundant `mkdir`, `writeFile`,
and `startProcess` operations every 5 seconds.

Three fixes:

**Recovery check.** At the top of `initializeSandbox()`, before any
file operations, call `sandbox.getExposedPorts()`. If port 3001 is
already exposed, skip everything and go straight to "ready." This
handles isolate eviction gracefully — the container is already running,
we just lost our memory of it.

**Catch `PortAlreadyExposedError`.** Even with the recovery check, a
race condition is possible. If a concurrent request exposes the port
between our check and our `exposePort` call, we catch the error,
construct the preview URL from the known pattern, and treat it as
success.

**Stop auto-retrying on error.** If initialization fails, return the
error to the client. The user can retry via the Retry button, which
reloads the page with a fresh sandbox ID. No more infinite retry loops.

## The `[object Object]` bug

After deploying, every page returned the literal string `[object
Object]`. Fifteen bytes, `content-type: text/html`. The middleware ran,
`app.render()` returned a valid Response, but the body was wrong.

Root cause: a known interaction between Astro, `nodejs_compat`, and
workerd ([astro#14511](https://github.com/withastro/astro/issues/14511)).
With `nodejs_compat` enabled, workerd exposes native `process` v2, which
makes Astro's internal `isNode` check evaluate to `true`. Astro then
returns `AsyncIterable` response bodies instead of `ReadableStream`.
workerd's `Response` constructor doesn't support `AsyncIterable`, so
the body gets coerced to its string representation: `"[object Object]"`.

The production fix was straightforward: `fetch_iterable_type_support` in
compatibility flags makes workerd's Response constructor accept
`AsyncIterable` bodies. It auto-enables at compat date `2026-02-19`.

But this didn't fix local dev. `astro dev` runs your SSR code inside
workerd via Miniflare (injected by `@cloudflare/vite-plugin`), but the
chunk evaluation ordering means Astro's `isNode` detection runs in a
dependency chunk that evaluates before the process polyfill is applied.
Even with the right compat date and the right workerd version,
`isNode` evaluates to `true` too early.

The robust fix for both environments: `disable_nodejs_process_v2`.
This prevents workerd from exposing `process` v2 entirely, so Astro
never misdetects the runtime. It attacks the root cause rather than
patching the symptom.

## The deploy pipeline gap

`astro build` generates `dist/server/wrangler.json`, which wrangler
uses for deploy. The Astro Cloudflare adapter copies most fields from
`wrangler.jsonc` into this generated config — bindings, containers,
migrations — but drops `routes` and `workers_dev`. Without routes,
`wrangler deploy` uploads the worker but doesn't attach it to the
custom domain. The worker is unreachable.

The fix is a small Node script that runs between `astro build` and
`wrangler deploy`, injecting the missing fields:

```
"deploy": "wrangler types && astro build && node scripts/patch-deploy-config.mjs && wrangler deploy"
```

Fragile, yes. If the adapter starts carrying routes through, the script
becomes a no-op that should be removed. But until Astro v6 reaches GA,
this is the gap.

## Dynamic imports for `@cloudflare/sandbox`

Top-level `import { getSandbox } from "@cloudflare/sandbox"` in Astro
actions and middleware causes module resolution failures, even with Astro
v6's workerd dev server. The fix is dynamic import inside the handler:

```typescript
const { getSandbox } = await import("@cloudflare/sandbox");
```

This applies everywhere the SDK is used — the action handler, the
middleware, the initialization function. It's ugly but required. The
module system in the Astro-workerd bridge doesn't resolve the SDK
correctly at the top level.

## What the final architecture looks like

```
Browser
  │
  ├─ loads index.astro (SSR page)
  ├─ calls actions.startSandbox() (Astro Action → returns "initializing")
  ├─ connects WebSocket to /api/ws?sandboxId=... (progress channel)
  └─ [if WS silent after 5s] polls actions.startSandbox() every 5s

Astro middleware
  └─ proxyToSandbox() intercepts preview URL requests (*.sandbox.cfsa.dev)

Worker (waitUntil keeps it alive)
  ├─ mkdir /workspace
  ├─ writeFile package.json, server.js
  ├─ startProcess "node server.js"
  ├─ health check loop (curl localhost:3001/health)
  ├─ exposePort 3001 → preview URL
  └─ broadcast { type: "ready", previewUrl } via WebSocket

Browser receives "ready"
  └─ sets iframe src to preview URL → Express JSON response visible
```

Nine source files. ~450 lines of application code (excluding types and
config). Twenty-five documented decisions, most of them born from
something breaking.

## Extracting the reusable parts

After the implementation stabilized, a pattern became clear: most of the
code wasn't about Express. It was about managing sandbox lifecycle on
the server and tracking initialization progress on the client. Every
project that uses `@cloudflare/sandbox` will need the same plumbing.

The question was what to extract. The answer turned out to be two
distinct libraries — one for each side of the network boundary.

### Server: `SandboxManager`

The server-side code had a lot of moving parts, but they all served
the same purpose: keep the sandbox alive, tell clients what's happening,
and recover gracefully when things go wrong. The app-specific part —
what files to write, what process to start, what health check to run —
was a small fraction of the total.

`SandboxManager` takes a configuration object with `port`, `token`, and
an `initialize` callback. The callback receives a sandbox handle and a
`progress` function. Everything else — the in-memory state map, the
idempotent start state machine, TTL cleanup, `sleepAfter` alignment,
WebSocket connection tracking, broadcast, isolate eviction recovery via
`getExposedPorts()`, `PortAlreadyExposedError` handling, the WS upgrade
handler — is managed by the class.

The app-specific file went from 450 lines to 90. It instantiates the
manager and provides the Express setup logic:

```typescript
const manager = new SandboxManager({
  port: 3001,
  token: "express",
  initialize: async ({ sandbox, progress }) => {
    progress("writing_files");
    await sandbox.writeFile("/workspace/server.js", expressCode);
    progress("starting_server");
    await sandbox.startProcess("node server.js", { cwd: "/workspace" });
    // health check ...
  },
});
```

The action handler becomes one line: `manager.start(sandboxId, host,
binding, waitUntil)`. The WebSocket API route becomes one line:
`manager.handleWebSocketUpgrade(request, sandboxId)`.

I initially dismissed this extraction as "tightly coupled to the Sandbox
SDK." That framing was wrong. Tight coupling to the SDK is exactly the
point — it's the "you'll need this every time you use
`@cloudflare/sandbox`" layer. The alternative is every project
re-discovering the isolate eviction bug, the `PortAlreadyExposedError`
infinite loop, the `wsHasDelivered` timing issue, and the TTL cleanup
strategy from scratch.

### Client: `SandboxPreview`

The client-side code had a different extraction boundary. The
WS-primary-with-deferred-polling pattern is genuinely framework-agnostic
— it doesn't care whether you're using Alpine, React, Svelte, or
vanilla JS. It just needs two callbacks (`start` and `poll`) and emits
three events (`progress`, `ready`, `error`).

`SandboxPreview` is an event emitter with lifecycle management:

```typescript
const preview = new SandboxPreview({
  start: () => actions.startSandbox({ sandboxId, host }),
  poll: () => actions.startSandbox({ sandboxId, host }),
});

preview.on("progress", ({ step }) => updateSpinner(step));
preview.on("ready", ({ previewUrl }) => showIframe(previewUrl));
preview.on("error", ({ message }) => showError(message));

preview.init();
```

It encapsulates the WebSocket connection with auto-reconnect, the
`wsHasDelivered` tracking that only counts substantive messages, the
deferred polling fallback with configurable grace period, self-canceling
polling when WS comes alive, and full cleanup on terminal states or
`destroy()`.

The Astro component went from 200 lines of interleaved WS/polling/DOM
logic to 60 lines of Alpine directives wired to `SandboxPreview`
events. If you wanted to use React instead, the wiring is a `useEffect`
with cleanup — the library doesn't care.

### What stays app-specific

The boundary is clean. For a new project using `@cloudflare/sandbox`:

1. Copy `sandbox-manager.ts` and `sandbox-preview.ts`
2. Write your own initialization callback (your files, your processes,
   your health checks)
3. Wire the action and WS route to the manager (one line each)
4. Wire `SandboxPreview` to your UI framework (event handlers)

The middleware (`proxyToSandbox`), the worker entry (DO re-export), and
the Astro page structure stay the same across projects. The Dockerfile
changes based on what runtime your sandbox needs. The `initialize`
callback is the only logic that's truly unique per project.

## Lessons

**Dev/prod parity is non-negotiable for Workers projects.** The Astro
v5 → v6 upgrade was the single most impactful decision. Every
subsequent bug was discoverable and fixable because the dev server ran
the same runtime as production.

**`waitUntil` is a different I/O universe.** Code running inside
`waitUntil` can't reliably communicate with WebSocket connections from
other requests. If you're designing a system where background work needs
to notify clients, build the polling fallback from day one — just make
it a last resort, not a primary channel.

**Isolate eviction is not an edge case.** Workers isolates get evicted
constantly — deploys, inactivity, platform restarts. Any state held in
module-scope variables will vanish. If your initialization creates
durable resources (running containers, exposed ports), you need a
recovery path that detects what already exists before trying to create
it again.

**The Astro + Cloudflare adapter stack is powerful but has seams.** The
`[object Object]` bug, the missing deploy routes, the dynamic import
requirement — these are all friction points at the boundary between
Astro's build system and the Cloudflare Workers runtime. They're
solvable, but you need to know they exist.

**Containers take time to start, and that time is the UX problem.** The
Sandbox SDK itself is straightforward. The hard part is the 5-30 seconds
between "user clicked" and "container is ready," and making that gap
feel intentional rather than broken. WebSocket progress updates,
polling fallbacks, health check loops, iframe loading — most of the
client-side complexity exists to bridge this gap gracefully.
