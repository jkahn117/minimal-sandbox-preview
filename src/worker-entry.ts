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
    // to the container.
    const proxyResponse = await proxyToSandbox(request, env);
    if (proxyResponse) return proxyResponse;
    // Everything below is your own application (Astro routes, API
    // endpoints, etc.) served from the main domain.
    return handler.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
