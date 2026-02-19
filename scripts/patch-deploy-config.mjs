/**
 * Patches the Astro-generated wrangler config (dist/server/wrangler.json)
 * to include routes and workers_dev from the source wrangler.jsonc.
 *
 * The Astro Cloudflare adapter doesn't carry these fields through to the
 * generated deploy config, so wrangler deploy doesn't attach the worker
 * to the correct routes.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const generatedPath = resolve("dist/server/wrangler.json");
const generated = JSON.parse(readFileSync(generatedPath, "utf-8"));

// Fields the Astro adapter drops from wrangler.jsonc
// Add routes so the worker is reachable on the custom domain
generated.routes = [
  {
    pattern: "sandbox.cfsa.dev",
    custom_domain: true,
  },
  {
    pattern: "*.sandbox.cfsa.dev",
    zone_name: "cfsa.dev",
  },
];

// Disable workers.dev subdomain — only serve on custom domain
generated.workers_dev = false;

writeFileSync(generatedPath, JSON.stringify(generated, null, 2));

console.log("Patched dist/server/wrangler.json with routes and workers_dev");
