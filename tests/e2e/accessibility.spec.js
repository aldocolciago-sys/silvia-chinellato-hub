import AxeBuilder from '@axe-core/playwright';
import { test, expect, openSite, loginViaUi } from './fixtures.js';
import { seedDocs } from '../fixtures/seed.js';

const BLOCKING = ['critical', 'serious'];
const summarize = (violations) => violations.map(v => `${v.id} (${v.impact}): ${v.nodes.map(n => n.target.join(' ')).join(', ')}`);

test.describe('accessibilità (axe-core, WCAG 2.1 AA)', () => {
    test.use({ firebaseSeed: { docs: seedDocs(), popupUser: { email: 'silviachine@gmail.com', uid: 'uid-silviachine@gmail.com' } } });

    test('sito pubblico: nessuna violazione critica o grave (escluso problema noto)', async ({ page }) => {
        await openSite(page);
        const results = await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
            .exclude('#public-news-grid .bg-water-50') // KNOWN ISSUE: contrasto 4.45:1 del badge data news (vedi test sotto)
            .analyze();
        expect(summarize(results.violations.filter(v => BLOCKING.includes(v.impact)))).toEqual([]);
    });

    // KNOWN ISSUE: il badge con la data delle news (text-slate-500 su bg-water-50) ha contrasto 4.45:1 < 4.5:1.
    test('il badge data delle news ha contrasto sufficiente', async ({ page }) => {
        test.fail();
        await openSite(page);
        const results = await new AxeBuilder({ page }).withRules(['color-contrast']).include('#public-news-grid').analyze();
        expect(results.violations).toEqual([]);
    });

    test('area riservata: nessuna violazione critica o grave', async ({ page }) => {
        await loginViaUi(page);
        const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
        expect(summarize(results.violations.filter(v => BLOCKING.includes(v.impact)))).toEqual([]);
    });

    // KNOWN ISSUE: nel modulo appuntamento le <label> non sono associate ai campi (manca for/id)
    // e il pulsante di chiusura ha solo un'icona: axe segnala button-name, label e select-name (critical).
    test('modulo appuntamento: nessuna violazione critica o grave', async ({ page }) => {
        test.fail();
        await loginViaUi(page);
        await page.evaluate(() => window.openStudioModal());
        await expect(page.locator('#studio-modal')).toBeVisible();
        const results = await new AxeBuilder({ page }).include('#studio-modal').withTags(['wcag2a', 'wcag2aa']).analyze();
        expect(summarize(results.violations.filter(v => BLOCKING.includes(v.impact)))).toEqual([]);
    });

    test('tutte le immagini hanno un testo alternativo', async ({ page }) => {
        await openSite(page);
        const missing = await page.locator('img').evaluateAll(imgs => imgs.filter(i => !i.hasAttribute('alt')).map(i => i.outerHTML));
        expect(missing).toEqual([]);
    });

    test('i pulsanti con sola icona hanno un nome accessibile', async ({ page }) => {
        await loginViaUi(page);
        const unnamed = await page.locator('#private-view header button').evaluateAll(buttons => buttons
            .filter(b => !b.textContent.trim() && !b.getAttribute('title') && !b.getAttribute('aria-label'))
            .map(b => b.outerHTML.slice(0, 120)));
        expect(unnamed).toEqual([]);
    });
});
