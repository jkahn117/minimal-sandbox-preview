import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  output: 'server',
  adapter: cloudflare({
    runtime: {
      mode: 'local'
    }
  }),
  vite: {
    build: {
      rollupOptions: {
        input: {
          worker: './src/worker/index.ts'
        }
      }
    }
  }
});
