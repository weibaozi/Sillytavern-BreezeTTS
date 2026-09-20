import { defineConfig } from '@playwright/test';

const port = Number(process.env.BREEZE_PREVIEW_PORT || 8019);
export default defineConfig({
    testDir: './tests/browser',
    timeout: 30000,
    expect: { timeout: 7000 },
    fullyParallel: false,
    workers: 1,
    reporter: 'list',
    outputDir: 'test-results/browser',
    use: {
        channel: 'msedge',
        headless: true,
        baseURL: `http://127.0.0.1:${port}`,
        viewport: { width: 1440, height: 1000 },
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure',
    },
    webServer: {
        command: 'node tools/preview-server.mjs',
        url: `http://127.0.0.1:${port}`,
        reuseExistingServer: !process.env.CI,
        timeout: 15000,
    },
});
