import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
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
