import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// En développement (npm run dev), /api est relayé à la gateway.
// En production, le front est servi par nginx (voir nginx/default.conf.template).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // joignable depuis une autre machine (VM, serveur distant), quel que soit son nom :
    // c'est un serveur de développement, jamais exposé en production
    host: true,
    allowedHosts: true,
    proxy: { "/api": { target: process.env.GATEWAY_URL ?? "http://localhost:3000" } },
  },
});
