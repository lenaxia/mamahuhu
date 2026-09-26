import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: ".",
  build: { outDir: "dist/web" },
  server: {
    port: 5173,
    allowedHosts: true, // platform dev-preview proxies with its own host header
    proxy: {
      "/api": "http://localhost:8787",
      "/audio": "http://localhost:8787",
      "/healthz": "http://localhost:8787",
    },
  },
});
