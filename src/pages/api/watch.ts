import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";

/**
 * SSE endpoint that watches a directory inside a running sandbox container
 * and streams change events to the browser.
 *
 * Uses the Sandbox SDK's watch() API (inotify-based) to detect filesystem
 * changes in real-time. The browser connects via EventSource and receives
 * typed events (modify, create, delete, etc.) that it can act on — for
 * example, refreshing a preview iframe when slides.md changes.
 *
 * Query params:
 *   - sandboxId (required): ID of the running sandbox
 *   - dir (required): directory to watch (e.g. /workspace/app)
 *   - file (optional): only emit events for this filename (e.g. slides.md)
 */
export const GET: APIRoute = async ({ url }) => {
  const sandboxId = url.searchParams.get("sandboxId");
  const watchDir = url.searchParams.get("dir");
  const filterFile = url.searchParams.get("file"); // optional filename filter

  if (!sandboxId || !watchDir) {
    return new Response("Missing sandboxId or dir", { status: 400 });
  }

  try {
    const { getSandbox, parseSSEStream } = await import("@cloudflare/sandbox");
    const { Sandbox } = env as Env;
    const sandbox = getSandbox(Sandbox, sandboxId, { normalizeId: true });

    // watch() requires a directory path, not a file path.
    const stream = await sandbox.watch(watchDir, {
      recursive: false,
      exclude: ["node_modules", ".git"],
    });

    const { readable, writable } = new TransformStream<
      Uint8Array,
      Uint8Array
    >();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    const controller = new AbortController();

    // Process events in the background — the response stream keeps the
    // request alive so this doesn't need waitUntil.
    (async () => {
      try {
        for await (const event of parseSSEStream(stream, controller.signal)) {
          const typed = event as Record<string, unknown>;

          // If a filename filter is set, only forward events for that file
          if (filterFile && typed.type === "event") {
            const eventPath = String(typed.path || "");
            const filename = eventPath.split("/").pop();
            if (filename !== filterFile) continue;
          }

          const sseMessage = `data: ${JSON.stringify(typed)}\n\n`;
          await writer.write(encoder.encode(sseMessage));
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name !== "AbortError") {
          const errorMsg = `data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`;
          try {
            await writer.write(encoder.encode(errorMsg));
          } catch {
            // Writer may already be closed
          }
        }
      } finally {
        try {
          await writer.close();
        } catch {
          // Already closed
        }
      }
    })();

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (err) {
    // If watch() itself fails (e.g. directory doesn't exist, sandbox not ready)
    const message =
      err instanceof Error ? err.message : "Failed to start watch";
    console.error(`/api/watch failed for sandbox ${sandboxId}:`, message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
