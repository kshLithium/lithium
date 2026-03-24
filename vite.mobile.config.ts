import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.resolve(__dirname, "src/mobile-client"),
  base: "/",
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 4173,
    strictPort: true,
    proxy: {
      "/api/mobile": {
        target: process.env.VITE_MOBILE_API_ORIGIN || "http://127.0.0.1:8787",
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: path.resolve(__dirname, "dist-mobile"),
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, "src/mobile-client/index.html")
    }
  }
});
