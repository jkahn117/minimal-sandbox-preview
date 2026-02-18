# Cloudflare Sandbox SDK - Research Document

## Overview

The Cloudflare Sandbox SDK (Beta) enables running untrusted code securely in isolated environments. Built on Cloudflare Containers, it provides a TypeScript API for executing commands, managing files, running background processes, and exposing services from Workers applications.

## Core Concepts

### What is a Sandbox?

A sandbox is an isolated container environment with a full Linux environment that provides:

- Strong security boundaries
- Full command execution capabilities
- File system operations
- Background process management
- Service exposure via preview URLs

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Cloudflare Worker                        │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Sandbox SDK (@cloudflare/sandbox)                   │   │
│  │  - getSandbox()                                      │   │
│  │  - exec(), startProcess()                            │   │
│  │  - exposePort(), proxyToSandbox()                    │   │
│  └─────────────────────────────────────────────────────┘   │
│                      ↓                                      │
│         Durable Object (stateful coordination)              │
│                      ↓                                      │
│            Container Instance (isolated)                    │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  • Full Linux environment                            │   │
│  │  • Node.js, Python, Bun, etc.                        │   │
│  │  • Your custom packages                              │   │
│  │  • Running processes                                 │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## Key Features

### 1. Command Execution

```typescript
const result = await sandbox.exec("python --version");
// result: { stdout, stderr, exitCode, success }
```

### 2. Background Processes

```typescript
await sandbox.startProcess("npm run dev", {
  env: { PORT: "8080" },
  cwd: "/workspace/app",
});
```

### 3. File Operations

```typescript
await sandbox.writeFile("/workspace/hello.txt", "Hello!");
const file = await sandbox.readFile("/workspace/hello.txt");
await sandbox.mkdir("/workspace/project/src", { recursive: true });
```

### 4. Port Exposure (Preview URLs)

```typescript
const { url } = await sandbox.exposePort(8080, {
  hostname: "example.com",
  token: "api-v1", // Optional: for stable URLs
});
// URL format: https://8080-sandbox-id-api-v1.example.com
```

### 5. WebSocket Connections

```typescript
// Connect to WebSocket servers in sandbox
if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
  return await sandbox.wsConnect(request, 8080);
}
```

## Local Development vs Production

### Critical Differences

| Aspect              | Local Development (`wrangler dev`)         | Production (`wrangler deploy`)                       |
| ------------------- | ------------------------------------------ | ---------------------------------------------------- |
| **Port Exposure**   | Must add `EXPOSE` directives in Dockerfile | All ports available programmatically                 |
| **Preview URLs**    | `http://localhost:8787/...`                | `https://{port}-{sandbox-id}-{token}.yourdomain.com` |
| **Domain**          | Localhost only                             | Requires custom domain with wildcard DNS             |
| **Container Limit** | Limited by local machine resources         | Cloudflare-managed                                   |
| **Image Building**  | Built locally with Docker                  | Pushed to Cloudflare registry                        |

### Local Development Requirements

**1. Dockerfile must expose ports:**

```dockerfile
FROM docker.io/cloudflare/sandbox:0.7.4

# Required for local dev with exposePort()
EXPOSE 8000
EXPOSE 8080
EXPOSE 5173
```

**2. Wrangler configuration:**

```jsonc
{
  "containers": [
    {
      "class_name": "Sandbox",
      "image": "./Dockerfile",
    },
  ],
}
```

**3. Local Docker must be running**

### Production Requirements

**1. Custom domain with wildcard DNS:**

- `.workers.dev` does NOT support wildcard subdomains
- Must use your own domain (e.g., `example.com`)
- Configure wildcard: `*.example.com` → Worker

**2. SSL/TLS considerations:**

- First-level wildcards (`*.example.com`) covered by Universal SSL
- Second-level wildcards (`*.sandbox.example.com`) require Advanced Certificate Manager ($10/month) or custom certificate

**3. Port exposure works without Dockerfile EXPOSE:**

```typescript
// In production, all ports are available
await sandbox.exposePort(8080, { hostname: "api.example.com" });
```

## API Reference

### Core Functions

#### `getSandbox(binding, id, options?)`

Gets or creates a sandbox instance.

```typescript
const sandbox = getSandbox(env.Sandbox, "my-sandbox", {
  normalizeId: true, // Lowercase ID for preview URL compatibility
});
```

**Options:**

- `normalizeId`: Convert ID to lowercase (required for preview URLs)
- `keepAlive`: Keep container running (default: false)

#### `proxyToSandbox(request, env)`

Routes preview URL requests to the sandbox.

```typescript
const proxyResponse = await proxyToSandbox(request, env);
if (proxyResponse) return proxyResponse;
```

### Commands

#### `exec(command, options?)`

Execute a command and wait for completion.

```typescript
const result = await sandbox.exec("npm install", {
  cwd: "/workspace/app",
  env: { NODE_ENV: "production" },
  timeout: 60000,
});
```

#### `startProcess(command, options?)`

Start a background process.

```typescript
const process = await sandbox.startProcess("node server.js", {
  cwd: "/workspace",
  env: { PORT: "8080" },
});

// Later: stop the process
await process.stop();
```

### Ports

#### `exposePort(port, options)`

Expose a port with preview URL.

```typescript
const { port, url, name } = await sandbox.exposePort(8080, {
  hostname: "example.com",
  name: "api",
  token: "v1-stable", // 1-16 chars: a-z, 0-9, _, -
});
```

**Important:**

- Port 3000 is reserved (internal Bun server)
- Token must be unique per sandbox
- Re-exposing same port with same token is idempotent

#### `unexposePort(port)`

Remove port exposure.

```typescript
await sandbox.unexposePort(8080);
```

#### `getExposedPorts()`

List all exposed ports.

```typescript
const { ports, count } = await sandbox.getExposedPorts();
```

#### `validatePortToken(port, token)`

Validate token for custom auth.

```typescript
const isValid = await sandbox.validatePortToken(8080, "my-token");
```

### Files

#### `writeFile(path, content, options?)`

Write file to sandbox.

```typescript
await sandbox.writeFile("/workspace/app.js", 'console.log("hello")');
```

#### `readFile(path, options?)`

Read file from sandbox.

```typescript
const file = await sandbox.readFile("/workspace/app.js");
// file.content, file.size, file.modifiedAt
```

#### `mkdir(path, options?)`

Create directory.

```typescript
await sandbox.mkdir("/workspace/src/components", { recursive: true });
```

### WebSocket

#### `wsConnect(request, port)`

Connect to WebSocket server in sandbox.

```typescript
if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
  return await sandbox.wsConnect(request, 8080);
}
```

## Configuration

### wrangler.jsonc

```jsonc
{
  "name": "my-sandbox-app",
  "main": "./src/index.ts",
  "compatibility_date": "2025-02-18",

  // Container configuration
  "containers": [
    {
      "class_name": "Sandbox",
      "image": "./Dockerfile",
      "instance_type": "lite", // or "standard"
      "max_instances": 10,
    },
  ],

  // Durable Objects binding
  "durable_objects": {
    "bindings": [
      {
        "class_name": "Sandbox",
        "name": "Sandbox",
      },
    ],
  },

  // Migration (run once)
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["Sandbox"],
    },
  ],

  // Environment variables
  "vars": {
    "API_KEY": "production-key",
  },
}
```

### Dockerfile

```dockerfile
# Choose base image variant
FROM docker.io/cloudflare/sandbox:0.7.4

# Install Node.js 22 and pnpm
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    npm install -g pnpm

# Expose ports (REQUIRED for local development)
EXPOSE 3001
EXPOSE 8080
EXPOSE 5173

# Optional: Pre-install dependencies
WORKDIR /workspace
COPY package.json pnpm-lock.yaml ./
RUN pnpm install
```

### Base Image Variants

| Variant  | Tag               | Includes                                 |
| -------- | ----------------- | ---------------------------------------- |
| Default  | `:0.7.4`          | Node.js 20, Bun, git, curl, jq           |
| Python   | `:0.7.4-python`   | + Python 3.11, pandas, numpy, matplotlib |
| OpenCode | `:0.7.4-opencode` | + OpenCode CLI                           |

**Important:** Match npm package version with Docker image version.

## Common Patterns

### Basic Worker Setup

```typescript
import { getSandbox, proxyToSandbox, type Sandbox } from "@cloudflare/sandbox";

export { Sandbox } from "@cloudflare/sandbox";

type Env = {
  Sandbox: DurableObjectNamespace<Sandbox>;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // 1. Proxy preview URLs first
    const proxyResponse = await proxyToSandbox(request, env);
    if (proxyResponse) return proxyResponse;

    // 2. Get sandbox instance
    const sandbox = getSandbox(env.Sandbox, "my-sandbox", {
      normalizeId: true,
    });

    // 3. Your routes...
    const url = new URL(request.url);

    if (url.pathname === "/start") {
      // Start Express server
      await sandbox.startProcess("node server.js", {
        cwd: "/workspace",
        env: { PORT: "3001" },
      });

      // Wait for startup
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Expose port
      const { url: previewUrl } = await sandbox.exposePort(3001, {
        hostname: url.hostname,
        token: "express-api",
      });

      return Response.json({ previewUrl });
    }

    return new Response("Not found", { status: 404 });
  },
};
```

### Service Readiness Check

```typescript
// Wait for service to be ready before exposing
await sandbox.startProcess("node server.js", { env: { PORT: "8080" } });

// Poll health endpoint
for (let i = 0; i < 10; i++) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const check = await sandbox.exec(
    'curl -f http://localhost:8080/health || echo "not ready"',
  );
  if (check.stdout.includes("ok")) break;
}

await sandbox.exposePort(8080, { hostname });
```

### Multiple Services

```typescript
// Start backend
await sandbox.startProcess("node api.js", { env: { PORT: "8080" } });
await new Promise((resolve) => setTimeout(resolve, 2000));
const api = await sandbox.exposePort(8080, { hostname, name: "api" });

// Start frontend
await sandbox.startProcess("npm run dev", {
  cwd: "/workspace/frontend",
  env: { PORT: "5173", API_URL: "http://localhost:8080" },
});
await new Promise((resolve) => setTimeout(resolve, 3000));
const frontend = await sandbox.exposePort(5173, { hostname, name: "frontend" });

return Response.json({ api: api.url, frontend: frontend.url });
```

## Troubleshooting

### "Connection refused: container port not found"

**Cause**: Missing `EXPOSE` directive in Dockerfile for local development.

**Fix**: Add `EXPOSE <port>` for each port you plan to use.

### "Port 3000 is reserved"

**Cause**: Port 3000 is used internally by the Bun server.

**Fix**: Use ports 1024-65535, excluding 3000.

### "Preview URLs require lowercase sandbox IDs"

**Cause**: Sandbox ID has uppercase characters.

**Fix**: Use `normalizeId: true` option or lowercase IDs.

### Preview URL works locally but not in production

**Cause**: Missing custom domain or wildcard DNS.

**Fix**:

1. Add custom domain to Worker
2. Add wildcard DNS record: `*.example.com` → Worker
3. Wait for SSL provisioning

### Container startup timeout

**Cause**: Installing dependencies on first start.

**Fix**:

1. Pre-install in Dockerfile
2. Use `keepAlive: true` option
3. Increase timeout in Wrangler config

## Security Considerations

1. **Preview URLs are public by default** - Add authentication if exposing sensitive services
2. **Validate tokens** - Use `validatePortToken()` for custom auth
3. **Sandbox isolation** - Each sandbox is isolated but runs in shared infrastructure
4. **Resource limits** - Configure `max_instances` to prevent abuse

## Pricing

Based on underlying Cloudflare Containers platform:

- Compute time (CPU + memory)
- Storage (if using R2 mounting)
- Network egress

See [Sandbox Pricing](https://developers.cloudflare.com/sandbox/platform/pricing/) for details.

## Resources

- **Documentation**: https://developers.cloudflare.com/sandbox/
- **API Reference**: https://developers.cloudflare.com/sandbox/api/
- **GitHub**: https://github.com/cloudflare/sandbox-sdk
- **Discord**: https://discord.cloudflare.com

## Version Compatibility

Always match versions:

- npm: `@cloudflare/sandbox@0.7.4`
- Docker: `docker.io/cloudflare/sandbox:0.7.4`

Mismatched versions cause warnings and potential issues.
