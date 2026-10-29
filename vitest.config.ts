import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    // Only run TypeScript source tests — never the compiled copies in dist/.
    include: ["**/__tests__/**/*.test.ts", "**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // Tests never call TypeSafe with a real key; a test that needs Jev stubs it.
    env: { TYPESAFE_API_KEY: "" },
  },
  resolve: {
    alias: {
      "@": path.resolve(process.cwd(), "./src"),
    },
  },
});
