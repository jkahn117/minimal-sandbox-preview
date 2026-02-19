import handler from "@astrojs/cloudflare/entrypoints/server";
import { Sandbox } from "@cloudflare/sandbox";

export { Sandbox };

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    return handler.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
