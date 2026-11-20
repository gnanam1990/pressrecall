// Fresh-context browser acceptance for the PressRecall operator console.
// The webServer launches the real product entry point on a scratch var dir.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/browser",
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:4180",
    headless: true,
  },
  webServer: {
    command:
      "rm -rf .pw-var && PRESSRECALL_VAR_DIR=.pw-var PORT=4180 node dist/src/main.js",
    url: "http://127.0.0.1:4180/api/health",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
