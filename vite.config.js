import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 3000,
  },
  // Polyfill Node globals that Privy/buffer expect in the browser.
  define: {
    global: 'globalThis',
  },
});
