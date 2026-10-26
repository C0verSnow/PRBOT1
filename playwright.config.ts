import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
export default defineConfig({
  testDir: "./tests/e2e", fullyParallel: false, workers: 1,
  use: { baseURL: "http://127.0.0.1:3100", trace: "retain-on-failure", screenshot: "only-on-failure" },
  reporter: [["list"], ["html", { open: "never" }]],
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }, { name: "mobile", use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" } }],
  webServer: {
    command: "npm run start -- --port 3100", url: "http://127.0.0.1:3100", reuseExistingServer: false,
    env: { CODEX_PATH_OVERRIDE: path.resolve("scripts/fake-codex.mjs"), PRBOT_DATA_DIR: ".data/e2e", CODEX_WORKSPACE: path.resolve(".data/workspace"), CODEX_API_KEY: "", OPENAI_API_KEY: "" },
  },
});
