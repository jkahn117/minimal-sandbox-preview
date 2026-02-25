import { defineAction } from "astro:actions";
import { z } from "astro/zod";
import { env } from "cloudflare:workers";
import { sandboxManager } from "../lib/sandbox";

/** Get a sandbox handle for an already-running container. */
async function getSandboxHandle(sandboxId: string) {
  const { getSandbox } = await import("@cloudflare/sandbox");
  const { Sandbox } = env as Env;
  return getSandbox(Sandbox, sandboxId, { normalizeId: true });
}

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

      return sandboxManager.start(
        input.sandboxId,
        input.host,
        Sandbox,
        waitUntil,
      );
    },
  }),

  readFile: defineAction({
    input: z.object({
      sandboxId: z.string(),
      filePath: z.string(),
    }),
    handler: async (input) => {
      const sandbox = await getSandboxHandle(input.sandboxId);
      const file = await sandbox.readFile(input.filePath, {
        encoding: "utf-8",
      });
      return { content: file.content };
    },
  }),

  writeFile: defineAction({
    input: z.object({
      sandboxId: z.string(),
      filePath: z.string(),
      content: z.string(),
    }),
    handler: async (input) => {
      const sandbox = await getSandboxHandle(input.sandboxId);
      await sandbox.writeFile(input.filePath, input.content);
      return { success: true };
    },
  }),
};
