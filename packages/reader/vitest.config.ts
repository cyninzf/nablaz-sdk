import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // R-S189-8 (iv): the fork run's (c)-share line is part of its output, passing or not.
    silent: false,
    projects: [
      { test: { name: "unit", include: ["test/unit/**/*.test.ts"] } },
      {
        test: {
          name: "fork",
          include: ["test/fork/**/*.test.ts"],
          testTimeout: 1_200_000,
          hookTimeout: 1_200_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
