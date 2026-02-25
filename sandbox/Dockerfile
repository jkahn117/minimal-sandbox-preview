FROM docker.io/cloudflare/sandbox:0.7.4

# Install Node.js 22.x with SSL verification disabled for local dev
RUN curl -fsSLk https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get update && \
    apt-get install -y nodejs && \
    npm install -g pnpm && \
    rm -rf /var/lib/apt/lists/*

# Verify installations
RUN node --version && pnpm --version

# Expose port 3001 for vinext app
# NOTE: Port 3000 is reserved by Sandbox internal Bun server
EXPOSE 3001

# Set working directory
WORKDIR /workspace

# The base image already has ENTRYPOINT configured
# Don't override it - the sandbox binary will start automatically
