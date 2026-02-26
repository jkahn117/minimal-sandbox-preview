FROM docker.io/cloudflare/sandbox:0.7.4

# Pre-bake the Vue + Vite app so containers start instantly with no
# network dependency. Only App.vue is written at runtime (the editable file).

WORKDIR /workspace/app

# Copy package.json first for layer caching
COPY app/package.json ./
RUN npm install

# Copy the rest of the app scaffold
COPY app/ ./

# Expose port 3001 for the Vite dev server
# NOTE: Port 3000 is reserved by Sandbox internal Bun server
EXPOSE 3001

WORKDIR /workspace

# The base image already has ENTRYPOINT configured
# Don't override it - the sandbox binary will start automatically
