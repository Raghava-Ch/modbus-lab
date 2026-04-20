import { resolve } from "node:path";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: {
      "@shared-frontend": resolve(__dirname, "../../packages/shared-frontend/src"),
    },
  },
  server: {
    port: 1421,
    strictPort: true,
  },
});
