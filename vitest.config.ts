import { defineConfig } from "vitest/config";

// Pure-logic tests run in plain Node (no Workers pool / wrangler bindings
// needed). The moltbook client only depends on global fetch, which we stub.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
