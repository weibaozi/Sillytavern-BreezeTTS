import { test, expect } from '@playwright/test';

test('root manifest loads the Git installation assets and isolated panel stylesheet', async ({ page, request }) => {
    const manifestResponse = await request.get('/manifest.json');
    expect(manifestResponse.ok()).toBe(true);
    const manifest = await manifestResponse.json();
    expect(manifest).toMatchObject({ js: 'index.js', css: 'style.css' });
    const failures = [];
    page.on('pageerror', error => failures.push(error.message));
    page.on('requestfailed', request => failures.push(request.url()));
    page.on('response', response => {
        if (/\.(?:js|css)(?:\?|$)/.test(response.url()) && !response.ok()) failures.push(response.url());
    });
    await page.goto('/');
    await expect(page.locator(`script[src="/${manifest.js}"]`)).toBeAttached();
    await expect(page.locator(`link[href="/${manifest.css}"]`)).toBeAttached();
    await page.getByRole('button', { name: '打开扩展菜单' }).click();
    await page.locator('#breeze_studio_wand_entry').click();
    const studio = page.locator('#breeze-studio-host');
    await expect(studio.locator('dialog')).toBeVisible();
    await expect(studio.locator('link[rel="stylesheet"]')).toHaveAttribute('href', /\/panel\.css$/);
    expect(failures).toEqual([]);
    for (const path of ['/package.json', '/playwright.config.js', '/tools/runtime-files.json', '/tests/install-layout.test.js']) {
        expect((await request.get(path)).status()).toBe(404);
    }
});
