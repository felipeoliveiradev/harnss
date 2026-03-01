import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: ["electron/src/**/*.test.ts"],
    environment: "node",
    alias: {
      "@shared/": path.resolve(__dirname, "shared/"),
    },
    restoreMocks: true,
  },
});
