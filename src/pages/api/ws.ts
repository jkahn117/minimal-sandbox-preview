import type { APIRoute } from "astro";
import { sandboxManager } from "../../lib/sandbox";

export const GET: APIRoute = async ({ request, url }) => {
  const sandboxId = url.searchParams.get("sandboxId");
  if (!sandboxId) {
    return new Response("Missing sandboxId", { status: 400 });
  }

  return sandboxManager.handleWebSocketUpgrade(request, sandboxId);
};
