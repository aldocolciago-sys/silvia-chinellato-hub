import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT || 4173);
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
    testDir: 'tests/e2e',
    globalSetup: './tests/e2e/global-setup.js',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    workers: process.env.CI ? 2 : undefined,
    timeout: 30_000,
    expect: { timeout: 7_000 },
    reporter: process.env.CI
        ? [['list'], ['html', { open: 'never' }], ['github']]
        : [['list'], ['html', { open: 'never' }]],
    use: {
        baseURL,
        locale: 'it-IT',
        timezoneId: 'Europe/Rome',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure'
    },
    projects: [
        { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 900 } } },
        { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } }
    ],
    webServer: {
        command: 'node tests/support/server.mjs',
        url: `${baseURL}/`,
        env: { PORT: String(PORT) },
        reuseExistingServer: !process.env.CI,
        timeout: 20_000
    }
});
