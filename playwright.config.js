'use strict';

// Browser tests (npm run test:browser): the pages in Chromium against the real server, started
// with a temporary data folder by test/browser/global-setup.js. Needs Playwright's browser once:
//   npx playwright install chromium --only-shell
// (or PLAYWRIGHT_CHANNEL=msedge / chrome to use an installed Edge or Chrome instead).

const fs = require('fs');
const path = require('path');
const { defineConfig } = require('@playwright/test');

// Live listening hears the test conversation through a fake microphone (when it was generated).
const conversation = path.join(__dirname, 'test', 'fixtures', 'conversation.wav');
const fakeMicrophone = fs.existsSync(conversation) ? [`--use-file-for-fake-audio-capture=${conversation}%noloop`] : [];

module.exports = defineConfig({
  testDir: 'test/browser',
  globalSetup: require.resolve('./test/browser/global-setup.js'),
  // One server and one data folder for all tests; transcribing needs the CPU anyway.
  workers: 1,
  timeout: 60 * 1000,
  expect: { timeout: 10 * 1000 },
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0, // a test that passes on the second try is reported as flaky
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  outputDir: 'test-results',
  use: {
    baseURL: process.env.VOICERECON_TEST_URL,
    storageState: process.env.VOICERECON_TEST_STATE,
    locale: 'en-US', // the pages follow the browser's language
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    permissions: ['microphone'],
    launchOptions: {
      args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', ...fakeMicrophone],
    },
  },
});
