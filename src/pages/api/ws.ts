import type { APIRoute } from "astro";
import { getConnections, getState } from "../../lib/sandbox";

export const GET: APIRoute = async ({ request }) => {
  const upgradeHeader = request.headers.get("Upgrade");
  if (upgradeHeader !== "websocket") {
    return new Response("Expected websocket", { status: 400 });
  }

  const [client, server] = Object.values(new WebSocketPair());
  const connections = getConnections();
  const state = getState();

  server.accept();
  connections.add(server);

  // Send current state to newly connected client
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
  } else {
    server.send(JSON.stringify({ type: "connected" }));
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
