import { defineMiddleware } from "astro:middleware";
import { env } from "cloudflare:workers";

/**
 * Astro middleware that intercepts sandbox preview URL requests.
 *
 * proxyToSandbox() checks the request hostname to determine if it's a
 * preview URL (e.g. 3001-sandbox-id-token.localhost:4321). If so, it
 * proxies the request to the sandbox container. If not, it returns null
 * and the request continues to Astro's normal routing.
 *
 * This must run before any other routing — Astro middleware is the right
 * place since it intercepts every request before pages/actions/API routes.
 */
export const onRequest = defineMiddleware(async ({ request }, next) => {
  const { Sandbox } = env as Env;

  if (Sandbox) {
    try {
      const { proxyToSandbox } = await import("@cloudflare/sandbox");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const proxyResponse = await proxyToSandbox(request, env as any);
      // Only return if it's an actual Response — proxyToSandbox can return
      // truthy non-Response objects (e.g. proxy stubs) which Astro would
      // serialize as "[object Object]".
      if (proxyResponse instanceof Response) {
        return proxyResponse;
      }
    } catch (err) {
      console.error("Sandbox proxy middleware error:", err);
    }
  }

  return next();
});
