import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
const apiPort = Number(process.env.DEPTHGUARD_API_PORT ?? 8800);
const webPort = Number(process.env.DEPTHGUARD_WEB_PORT ?? 5174);
export default defineConfig({
  root: "web",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: webPort,
    strictPort: true,
    proxy: {
      "/api": `http://127.0.0.1:${apiPort}`,
    },
  },
  build: { outDir: "dist" },
});
