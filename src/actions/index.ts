import { defineAction } from "astro:actions";
import { z } from "astro:schema";
import { env } from "cloudflare:workers";
import { sandboxManager } from "../lib/sandbox";

export const server = {
  startSandbox: defineAction({
    input: z.object({
      sandboxId: z.string(),
      host: z.string(),
    }),
    handler: async (input, context) => {
      const { cfContext } = context.locals;
      const waitUntil = cfContext.waitUntil.bind(cfContext);
      const { Sandbox } = env as Env;

      return sandboxManager.start(input.sandboxId, input.host, Sandbox, waitUntil);
    },
  }),
};
