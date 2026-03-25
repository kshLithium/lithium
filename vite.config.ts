import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self' http://127.0.0.1:5173 http://localhost:*",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: file:",
  "font-src 'self' data:",
  "connect-src 'self' http://127.0.0.1:5173 http://localhost:* ws://127.0.0.1:5173 ws://localhost:*",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'"
].join("; ");

const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: file:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'"
].join("; ");

export default defineConfig({
  base: "./",
  plugins: [
    react(),
    {
      name: "lithium-csp",
      transformIndexHtml(html, context) {
        return html.replace("__LITHIUM_CSP__", context.server ? DEV_CSP : PROD_CSP);
      }
    }
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) {
            return;
          }

          if (
            id.includes("react-markdown") ||
            id.includes("remark-gfm") ||
            id.includes("remark-math") ||
            id.includes("rehype-katex") ||
            id.includes("katex")
          ) {
            return "vendor-markdown";
          }

          if (id.includes("react")) {
            return "vendor-react";
          }
        }
      }
    }
  },
  server: {
    host: "127.0.0.1",
    port: 5173
  }
});
