FROM docker.io/cloudflare/sandbox:0.7.17

# Pre-bake the Slidev app so containers start instantly with no
# network dependency. Only slides.md is written at runtime (the editable file).

WORKDIR /workspace/app

# Copy package.json and .npmrc first for layer caching
COPY app/package.json app/.npmrc ./
RUN npm install

# Copy the rest of the app scaffold (slides.md, vite.config.ts)
COPY app/ ./

# Expose port 3001 for the Slidev dev server
# NOTE: Port 3000 is reserved by Sandbox internal Bun server
EXPOSE 3001

WORKDIR /workspace

# The base image already has ENTRYPOINT configured
# Don't override it - the sandbox binary will start automatically
