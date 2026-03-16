/**
 * Non-WebSocket fallback for /api/ws.
 *
 * Actual WebSocket upgrades are intercepted at the Worker level in
 * worker-entry.ts (before Astro's handler), because Astro's render
 * pipeline doesn't properly pass through 101 WebSocket responses.
 *
 * This route only handles non-upgrade requests (e.g. accidental
 * browser navigation to /api/ws).
 */

import type { APIRoute } from "astro";

export const GET: APIRoute = async () => {
  return new Response("This endpoint requires a WebSocket upgrade request.", {
    status: 400,
    headers: { "Content-Type": "text/plain" },
  });
};
