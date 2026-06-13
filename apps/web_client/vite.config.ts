import { resolve } from "node:path";
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import wasm from 'vite-plugin-wasm';

export default defineConfig({
  plugins: [wasm(), svelte()],
  build: {
    target: 'esnext',
  },
  resolve: {
    alias: {
      "@shared-frontend": resolve(__dirname, "../../packages/shared-frontend/src"),
    },
  },
  optimizeDeps: {
    exclude: ["modbus-rs-wasm"],
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
