// Automated checks of the app's main tasks: npm test
// Every test starts with a brand-new, empty app in its own browser profile,
// so your real accounts data (desktop file, phone, cloud) is never touched.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'tests',
  timeout: 30000,
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    channel: 'msedge',          // uses the Microsoft Edge already on this computer
    viewport: { width: 1366, height: 820 },
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata'
  },
  projects: [
    { name: 'desktop' },
    { name: 'phone', use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } }
  ],
  webServer: {
    command: 'node tests/serve.js',
    url: 'http://127.0.0.1:4173/index.html',
    reuseExistingServer: true
  }
});
