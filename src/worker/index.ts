import { getSandbox, proxyToSandbox, type Sandbox } from "@cloudflare/sandbox";
import { Hono } from "hono";

// Re-export Sandbox for Durable Object binding
export { Sandbox } from "@cloudflare/sandbox";

// Environment type
type Env = {
  Sandbox: DurableObjectNamespace<Sandbox>;
};

// Track initialization state
let isInitialized = false;
let previewUrl: string | null = null;

const app = new Hono<{ Bindings: Env }>();

// Middleware to handle preview URL proxying
app.use("*", async (c, next) => {
  // Try to proxy to sandbox first (handles preview URLs)
  const proxyResponse = await proxyToSandbox(c.req.raw, c.env);
  if (proxyResponse) {
    return proxyResponse;
  }

  // Not a preview URL, continue to next handler
  await next();
});

// Main handler - auto-initialize sandbox on first request
app.get("/", async (c) => {
  const sandbox = getSandbox(c.env.Sandbox, "minimal-example-sandbox", {
    normalizeId: true, // CRITICAL: lowercase ID for preview URLs
  });

  // Initialize on first request
  if (!isInitialized) {
    try {
      console.log("Initializing sandbox and starting Express server...");

      // Setup workspace
      await sandbox.mkdir("/workspace", { recursive: true });

      // Write package.json
      await sandbox.writeFile(
        "/workspace/package.json",
        JSON.stringify(
          {
            name: "sandbox-express-app",
            version: "1.0.0",
            type: "module",
            dependencies: { express: "^4.18.2" },
          },
          null,
          2,
        ),
      );

      // Write Express server
      await sandbox.writeFile(
        "/workspace/server.js",
        `
import express from 'express';

const app = express();
const PORT = process.env.PORT || 3001;

app.get('/', (req, res) => {
  res.json({
    message: 'Hello from Express in Cloudflare Sandbox!',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    port: PORT
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('Express server running on port ' + PORT);
});
      `.trim(),
      );

      // Install dependencies
      console.log("Installing dependencies...");
      await sandbox.exec("npm install", { cwd: "/workspace" });

      // Start Express server
      console.log("Starting Express server...");
      await sandbox.startProcess("node server.js", {
        cwd: "/workspace",
        env: {
          PORT: "3001",
          NODE_ENV: "production",
        },
      });

      // Wait for startup
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Verify server is ready
      let isReady = false;
      for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const health = await sandbox.exec(
          'curl -s http://localhost:3001/health || echo "not ready"',
        );
        if (health.stdout.includes("ok")) {
          isReady = true;
          break;
        }
      }

      if (!isReady) {
        throw new Error("Server failed to start within timeout");
      }

      // Get the hostname from the request
      const requestUrl = new URL(c.req.url);
      const hostname = requestUrl.hostname;
      const host = c.req.header("host");

      console.log("Request URL:", c.req.url);
      console.log("Hostname:", hostname);
      console.log("Host header:", host);

      // Expose port
      const exposed = await sandbox.exposePort(3001, {
        hostname: host!,
        name: "express-server",
        token: "express",
      });

      console.log("Exposed URL from SDK:", exposed.url);

      // Check if we're in local dev
      const isLocalDev = hostname === "localhost" || hostname === "127.0.0.1";

      if (isLocalDev) {
        // In local dev, the SDK returns a subdomain-style URL like:
        // http://3001-minimal-example-sandbox-express.localhost:8787/
        //
        // For the iframe to work properly, we need to use a URL that:
        // 1. Points to localhost (which the SDK's URL does)
        // 2. Can be properly routed by proxyToSandbox
        //
        // The SDK's returned URL should work if .localhost resolves properly
        // If not, we may need to use the main Worker URL with special routing
        previewUrl = exposed.url;
      } else {
        // Production: use the exposed URL directly
        previewUrl = exposed.url;
      }

      isInitialized = true;

      console.log("✓ Sandbox initialized successfully");
      console.log("Environment:", isLocalDev ? "local" : "production");
      console.log("Preview URL for iframe:", previewUrl);
    } catch (error) {
      console.error("Failed to initialize sandbox:", error);
      return c.json(
        {
          error: "Failed to initialize sandbox",
          message: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  }

  // Return HTML page with iframe
  return c.html(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sandbox Preview</title>
  <style>
    body {
      font-family: system-ui, -apple-system, sans-serif;
      margin: 0;
      padding: 20px;
      background: #f5f5f5;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
    }
    h1 {
      margin: 0 0 10px 0;
    }
    .info {
      color: #666;
      margin-bottom: 20px;
    }
    .preview-url {
      background: #e3f2fd;
      padding: 10px;
      border-radius: 4px;
      margin-bottom: 20px;
      font-family: monospace;
      word-break: break-all;
    }
    iframe {
      width: 100%;
      height: 600px;
      border: 1px solid #ddd;
      border-radius: 4px;
      background: white;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Cloudflare Sandbox SDK Minimal Example</h1>
    <div class="info">
      Express.js server running inside Cloudflare Sandbox container
    </div>
    <div class="preview-url">
      Preview URL: ${previewUrl || "Initializing..."}
    </div>
    ${previewUrl ? `<iframe src="${previewUrl}" title="Sandbox Preview"></iframe>` : "<p>Loading...</p>"}
  </div>
</body>
</html>
  `);
});

// Export Hono app as default
export default app;
