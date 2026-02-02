import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "path";
import { codeInspectorPlugin } from "code-inspector-plugin";

export default defineConfig({
  plugins: [
    vue(),
    codeInspectorPlugin({
      bundler: "vite",
    }),
  ],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  server: {
    port: 3000,
    open: true,
  },
  build: {
    target: "esnext",
    sourcemap: process.env.VITE_SOURCEMAP === "true",
  },
});
