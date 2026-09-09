import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  build: {
    rollupOptions: { output: { manualChunks(id) {
      if (!id.includes("node_modules")) return;
      if (/\/three\//.test(id)) return "vendor-three";
      if (/\/(react|react-dom|scheduler|zustand|use-sync-external-store)\//.test(id)) return "vendor-react";
      if (/\/@xyflow\//.test(id)) return "vendor-flow";
      if (/\/ag-psd\//.test(id)) return "vendor-psd";
    } } },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  //    注意：本机另一个项目（弹宠）也用 Tauri 默认 1420，MOMO 固定在 1430，两项目可同时开发
  server: {
    port: 1430,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1431,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
