import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "esnext",
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const modulePath = id.replace(/\\/g, "/");

          if (/\/node_modules\/(marked|highlight\.js|dompurify)\//.test(modulePath)) {
            return "vendor-markdown";
          }

          if (modulePath.includes("/node_modules/@tauri-apps/")) {
            return "vendor-tauri";
          }
        },
      },
    },
  },
});
