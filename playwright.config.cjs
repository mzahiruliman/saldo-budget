const { defineConfig } = require("@playwright/test");
module.exports = defineConfig({
  testMatch: "*.spec.cjs",
  timeout: 15000,
  // The cross-engine layout matrix launches extra browsers; bound contention.
  workers: 2,
  use: {
    baseURL: "http://127.0.0.1:5175",
    launchOptions: { args: ["--no-sandbox"] },
  },
  webServer: {
    command: "node preview.cjs",
    url: "http://127.0.0.1:5175/health",
    reuseExistingServer: true,
    timeout: 5000,
  },
});
