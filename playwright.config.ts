import { defineConfig, devices } from "@playwright/test";

const browserChannel = process.env.FOCUS_PET_PLAYWRIGHT_CHANNEL as "chrome" | "msedge" | undefined;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  use: {
    trace: "on-first-retry",
    ...(browserChannel ? { channel: browserChannel } : {}),
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 920 } } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
});
