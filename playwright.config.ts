import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  use: {
    baseURL: "http://localhost:4173",
    viewport: { width: 390, height: 844 }, // iPhone-ish, mobile-first
    isMobile: true,
    hasTouch: true,
  },
  webServer: {
    command: "rm -f data/e2e.db* && LLM_MOCK=1 SQLITE_PATH=data/e2e.db PORT=4173 tsx src/server/index.ts",
    port: 4173,
    reuseExistingServer: false,
    timeout: 90000,
  },
});
