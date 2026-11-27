import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './fixtures.js';

/** Pagine dei servizi (fase 2 SEO): statiche, senza Firebase, collegate alla home e al modulo di contatto. */
const PAGES = [
    { path: '/osteopatia-carate-brianza.html', h1: 'Osteopatia a Carate Brianza' },
    { path: '/idrocolonterapia-carate-brianza.html', h1: 'Idrocolonterapia a Carate Brianza e Cinisello Balsamo' }
];
const BLOCKING = ['critical', 'serious'];

for (const { path, h1 } of PAGES) {
    test.describe(path, () => {
        test('si carica senza errori, senza richieste esterne e senza il calendario', async ({ page, pageErrors, blockedRequests }) => {
            const calendarRequests = [];
            page.on('request', request => { if (request.url().includes('fullcalendar')) calendarRequests.push(request.url()); });
            await page.goto(path);
            await expect(page.getByRole('heading', { level: 1, name: h1 })).toBeVisible();
            await expect(page.locator('#site-footer')).toContainText('P.IVA 13070370963');
            await page.waitForLoadState('load');
            expect(pageErrors.map(e => e.message)).toEqual([]);
            expect(blockedRequests).toEqual([]);
            expect(calendarRequests).toEqual([]);
            const broken = await page.locator('img').evaluateAll(imgs => imgs.filter(img => !(img.complete && img.naturalWidth > 0)).map(img => img.src));
            expect(broken).toEqual([]);
        });

        test('nessuna violazione di accessibilità critica o grave', async ({ page }) => {
            await page.goto(path);
            const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
            expect(results.violations.filter(v => BLOCKING.includes(v.impact)).map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`)).toEqual([]);
        });

        test('il link al modulo porta alla richiesta di appuntamento nella home', async ({ page }) => {
            await page.goto(path);
            await page.locator('main a[href="/#appointment-request"]').first().click();
            await expect(page).toHaveURL(/\/#appointment-request$/);
            await expect(page.locator('#appointment-request-form')).toBeVisible();
        });
    });
}

test('la home porta alle pagine dei servizi', async ({ page }) => {
    await page.goto('/');
    await page.locator('#trattamenti-pubblica a[href="/idrocolonterapia-carate-brianza.html"]').click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(PAGES[1].h1);
    await page.locator('header nav a[href="/osteopatia-carate-brianza.html"]').click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(PAGES[0].h1);
});
