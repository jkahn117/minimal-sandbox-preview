# Hot Reload Preview Implementation

This document explains how hot reload in the sandbox preview was implemented,
what broke along the way, and why the final design works.

---

## Goal

When a user edits and saves `App.vue` in the left editor pane:

1. The file should be written into the running sandbox container.
2. The Vite dev server inside that sandbox should detect or be notified.
3. The preview iframe should refresh via HMR when possible.
4. If HMR is not connected, the preview should still update reliably.

---

## Initial Behavior and Problem

The editor save flow already called `sandbox.writeFile(...)`, and writes were
visible in logs. However, Vite HMR did not consistently update the iframe.

We initially expected Vite's file watcher (polling enabled) to pick up the
change automatically, but in this setup that was unreliable.

---

## Implementation Phases

## 1) Added explicit HMR notify endpoint in Vite

Instead of relying purely on file watching, a dedicated internal endpoint was
added in sandbox Vite config:

- Route: `GET /__sandbox_hmr?file=...`
- Action: `server.ws.send({ type: "full-reload" })`
- Response: JSON ack including connected HMR client count

This made HMR notification explicit and synchronous with file save.

## 2) Triggered notify after each file write

After `sandbox.writeFile(...)`, the server action now executes:

`curl -sS -f "http://localhost:3001/__sandbox_hmr?..."`

Then it parses the JSON response and returns metadata:

- `hmrNotified`
- `hmrClients`

This avoids false positives where the request succeeds but did not actually hit
the intended handler.

## 3) Added browser-side fallback reload

If save succeeds but HMR is unavailable (`hmrNotified=false` or
`hmrClients===0`), the editor dispatches a browser event:

`sandbox:preview-reload`

`SandboxComponent` listens for that event and force-refreshes iframe `src` with
a cache-busting query parameter (`_ts=...`). This guarantees visible updates
even when HMR websocket is not active.

## 4) Ensured sandbox always uses the expected Vite config

One major source of confusion was stale container image/config state. To remove
that dependency, initialization now writes both files at startup:

- `/workspace/app/src/App.vue`
- `/workspace/app/vite.config.ts`

So each sandbox starts from known runtime config, independent of Docker layer
caching.

---

## Critical Bug Found During Debugging

We saw this error after save:

`file saved but HMR notify failed or invalid response: <!DOCTYPE html> ...`

That HTML response was Vite's index page, not our JSON ack. Root cause:

- Middleware was mounted with `server.middlewares.use("/__sandbox_hmr", ...)`
- Inside handler, we also checked `url.pathname === "/__sandbox_hmr"`
- In connect-style middleware, mounted prefixes are stripped from `req.url`
- So inside handler, `req.url` often looked like `/?file=...`
- The extra pathname check failed and called `next()`, leading to HTML fallback

Fix:

- Removed the redundant inner pathname guard.
- Kept only mount-level routing via `use("/__sandbox_hmr", ...)`.

After this, the endpoint consistently returned JSON and notify status was
accurate.

---

## Final Save-to-Preview Flow

1. User edits in `EditorPane` and clicks save (or `Cmd+S` / `Ctrl+S`).
2. `actions.writeFile` writes updated content to sandbox filesystem.
3. Action calls `__sandbox_hmr` endpoint in sandbox Vite.
4. Vite broadcasts full reload to connected HMR websocket clients.
5. If HMR is connected, iframe updates via Vite client.
6. If HMR is not connected, frontend falls back to iframe hard refresh event.

This gives both correctness and resilience.

---

## Files Involved

- `src/actions/index.ts`
  - Save action writes file, invokes HMR notify endpoint, validates JSON ack,
    returns `hmrNotified` and `hmrClients`.

- `src/components/EditorPane.astro`
  - On save completion, checks HMR metadata and dispatches
    `sandbox:preview-reload` fallback event when needed.

- `src/components/SandboxComponent.astro`
  - Subscribes to `sandbox:preview-reload` and force refreshes iframe URL with
    `_ts` query param.

- `src/lib/sandbox.ts`
  - Sandbox init writes runtime `App.vue` and runtime `vite.config.ts`.
  - Starts Vite process with polling-friendly environment settings.

- `sandbox/app/vite.config.ts`
  - Source Vite config in scaffold kept aligned with runtime behavior.

---

## Why This Design

This implementation intentionally treats HMR as best-effort and preview refresh
as guaranteed:

- Best-effort path: native Vite websocket HMR (fast, smooth updates).
- Guaranteed path: explicit fallback iframe reload when HMR cannot be trusted.

That combination resolved the original issue: saved edits now reliably appear in
the preview.
