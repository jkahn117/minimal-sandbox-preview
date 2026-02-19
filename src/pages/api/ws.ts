import type { APIRoute } from "astro";
import { getConnections, getState } from "../../lib/sandbox";

export const GET: APIRoute = async ({ request, url }) => {
  const upgradeHeader = request.headers.get("Upgrade");
  if (upgradeHeader !== "websocket") {
    return new Response("Expected websocket", { status: 400 });
  }

  const sandboxId = url.searchParams.get("sandboxId");
  if (!sandboxId) {
    return new Response("Missing sandboxId", { status: 400 });
  }

  const [client, server] = Object.values(new WebSocketPair());
  const connections = getConnections(sandboxId);
  const state = getState(sandboxId);

  server.accept();
  connections.add(server);

  // Send current state to newly connected client.
  // If init hasn't started or has no progress yet, stay silent — the
  // client is already showing "Initializing..." from the action response.
  // Sending a meaningless "connected" ack would trick the client into
  // thinking WS is delivering progress, suppressing the polling fallback.
  if (state.isInitialized && state.previewUrl) {
    server.send(
      JSON.stringify({ type: "ready", previewUrl: state.previewUrl }),
    );
  } else if (state.initError) {
    server.send(JSON.stringify({ type: "error", message: state.initError }));
  } else if (state.currentStep) {
    server.send(
      JSON.stringify({ type: "progress", step: state.currentStep }),
    );
  }

  server.addEventListener("close", () => {
    connections.delete(server);
  });

  return new Response(null, {
    status: 101,
    // @ts-ignore - webSocket property exists in Cloudflare Workers runtime
    webSocket: client,
  });
};
