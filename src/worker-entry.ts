import handler from "@astrojs/cloudflare/entrypoints/server";
import { proxyToSandbox, Sandbox } from "@cloudflare/sandbox";

export { Sandbox };

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    // Route preview-URL requests (HTTP + WebSocket) to the correct
    // sandbox container. This must be called first — before any
    // application logic — so that requests on exposed-port subdomains
    // (e.g. 3001-sandbox-{id}-slidev.sandbox.cfsa.dev) are forwarded
    // to the container. This also enables Vite HMR WebSocket
    // connections through the preview URL.
    const url = new URL(request.url);
    const isUpgrade = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
    console.log(`[worker] ${request.method} ${url.hostname}${url.pathname} upgrade=${isUpgrade}`);

    const proxyResponse = await proxyToSandbox(request, env);
    if (proxyResponse) {
      console.log(`[worker] proxyToSandbox handled -> ${proxyResponse.status} (ws=${proxyResponse.webSocket != null})`);
      return proxyResponse;
    }

    console.log(`[worker] proxyToSandbox returned null, forwarding to Astro`);
    // Everything below is your own application (Astro routes, API
    // endpoints, etc.) served from the main domain.
    return handler.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
