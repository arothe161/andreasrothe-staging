import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Liegt in app-src/. Baut das Bundle direkt in den Jekyll-Assets-Ordner,
// mit festen (nicht gehashten) Dateinamen, damit die Jekyll-Seite sie
// stabil per <script>/<link> referenzieren kann, ohne den Dateinamen bei
// jedem Build neu nachschlagen zu müssen.
export default defineConfig({
  plugins: [react()],
  base: "/assets/systembrett/",
  build: {
    outDir: "../assets/systembrett",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: "systembrett.js",
        chunkFileNames: "systembrett-[name].js",
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith(".css")) return "systembrett.css";
          return "[name][extname]";
        },
      },
    },
  },
});
