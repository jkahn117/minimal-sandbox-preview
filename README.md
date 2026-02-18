# Cloudflare Sandbox SDK Minimal Example

A working demonstration of Cloudflare's Sandbox SDK showing how to run an Express.js application inside an isolated container and expose it via preview URLs.

## Overview

This project demonstrates the core functionality of the Cloudflare Sandbox SDK by:

- Running an Express.js server inside an isolated Docker container
- Auto-initializing the sandbox on first request
- Exposing the container service via preview URLs
- Comparing local development vs production behaviors

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Cloudflare Worker                        │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Hono.js Router                                     │   │
│  │  - Auto-initializes sandbox on first request        │   │
│  │  - proxyToSandbox() for preview URL routing         │   │
│  └─────────────────────────────────────────────────────┘   │
│                      ↓                                      │
│         Durable Object (stateful coordination)              │
│                      ↓                                      │
│            Container Instance (isolated)                    │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  • cloudflare/sandbox                               │   │
│  │  • Node.js 22 + pnpm                                │   │
│  │  • Express.js server on port 3001                   │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## Key Findings

### Critical: Local Development Hostname

**The most important discovery:** In local development, you must pass `localhost:8787` (with the port) as the hostname to `exposePort()`, not just `localhost`.

```typescript
// ❌ Wrong - returns production-style URL
const exposed = await sandbox.exposePort(3001, {
  hostname: "localhost", // Just the hostname
});
// Returns: http://3001-sandbox-id-token.localhost/

// ✅ Correct - returns proper local dev URL
const exposed = await sandbox.exposePort(3001, {
  hostname: "localhost:8787", // Host with port
});
// Returns: http://localhost:8787/.cf/preview/3001/...
```

### Local Development vs Production

| Aspect          | Local Development (`wrangler dev`)      | Production (`wrangler deploy`)             |
| --------------- | --------------------------------------- | ------------------------------------------ |
| **Hostname**    | `localhost:8787` (with port!)           | `yourdomain.com`                           |
| **Preview URL** | `http://localhost:8787/.cf/preview/...` | `https://3001-{id}-{token}.yourdomain.com` |
| **Dockerfile**  | Must include `EXPOSE 3001`              | Not required                               |
| **SSL**         | HTTP only                               | HTTPS automatic                            |
| **Domain**      | None needed                             | Custom domain + wildcard DNS required      |

### Version Matching

SDK and Docker image versions **must match exactly**:

```
SDK:     @cloudflare/sandbox@0.7.4
Docker:  docker.io/cloudflare/sandbox:0.7.4
```

## Project Structure

```
.
├── package.json                    # Project dependencies
├── tsconfig.json                   # TypeScript config
├── wrangler.jsonc                  # Wrangler configuration
├── astro.config.mjs                # Astro + Cloudflare adapter
├── worker-configuration.d.ts       # Generated types
├── sandbox/
│   ├── Dockerfile                  # Container definition
│   └── express-app/
│       ├── package.json            # Express dependencies
│       ├── pnpm-lock.yaml          # Lockfile
│       └── server.js               # Express server code
└── src/
    ├── worker/
    │   └── index.ts                # Worker entry (auto-starts)
    └── pages/
        └── index.astro             # Frontend page
```

## Prerequisites

- Node.js 18+
- pnpm or npm
- Docker (for local development)
- Cloudflare account (for deployment)

## Installation

```bash
# Install dependencies
pnpm install

# Generate TypeScript types
npm run types
```

## Local Development

```bash
# Start the development server
pnpm run dev

# Access the application
# The Worker will auto-initialize and display an iframe
# with the Express server output
```

The dev server runs on `http://localhost:8787`.

## How It Works

### Auto-Initialization

On the first request to `/`:

1. Creates `/workspace` directory in the sandbox
2. Writes `package.json` with Express dependency
3. Writes `server.js` with Express app
4. Runs `npm install` to install dependencies
5. Starts Express server on port 3001
6. Waits for health check to pass
7. Exposes port with `exposePort(3001, { hostname: 'localhost:8787' })`
8. Returns HTML page with iframe pointing to the preview URL

### Key Code

```typescript
// Worker entry point (src/worker/index.ts)
const exposed = await sandbox.exposePort(3001, {
  hostname: "localhost:8787", // Critical: include port!
  name: "express-server",
  token: "express",
});

// The SDK returns the correct local dev URL:
// http://localhost:8787/.cf/preview/3001/...
```

## Troubleshooting

### "Connection refused: container port not found"

**Cause:** Missing `EXPOSE` directive in Dockerfile  
**Fix:** Add `EXPOSE 3001` to your Dockerfile

### "Port 3000 is reserved"

**Cause:** Using port 3000 which is reserved by Sandbox internal Bun server  
**Fix:** Use port 3001 or any port 1024-65535 except 3000

### Preview URL returns 404

**Cause:** Wrong hostname format in local dev  
**Fix:** Use `hostname: 'localhost:8787'` not just `'localhost'`

### "Preview URLs require lowercase sandbox IDs"

**Cause:** Sandbox ID has uppercase characters  
**Fix:** Use `normalizeId: true` option in `getSandbox()`

### Container startup timeout

**Cause:** Installing dependencies takes too long  
**Fix:** Pre-install in Dockerfile or increase timeout

## Important Notes

1. **Port 3000 is reserved** - Never use it for your services
2. **Version matching** - SDK and Docker image must match exactly
3. **Local dev hostname** - Must include port (`localhost:8787`)
4. **Production domain** - Requires custom domain with wildcard DNS
5. **First deploy** - Takes 2-3 minutes for container provisioning

## Resources

- [Cloudflare Sandbox SDK Docs](https://developers.cloudflare.com/sandbox/)
- [API Reference](https://developers.cloudflare.com/sandbox/api/)
- [Expose Services Guide](https://developers.cloudflare.com/sandbox/guides/expose-services/)
- [Production Deployment](https://developers.cloudflare.com/sandbox/guides/production-deployment/)
