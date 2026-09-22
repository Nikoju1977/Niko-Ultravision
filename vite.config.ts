import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  worker: {
    // Le worker IA importe onnxruntime dynamiquement : format ES requis.
    format: "es",
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
