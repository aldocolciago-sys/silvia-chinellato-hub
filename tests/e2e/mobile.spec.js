import { test, expect, loginViaUi, isMobile, localDate } from './fixtures.js';
import { seedDocs, center, studioEvent } from '../fixtures/seed.js';

const today = localDate(0);

test.describe('esperienza mobile dell’area riservata', () => {
    test.use({
        firebaseSeed: {
            popupUser: { email: 'silviachine@gmail.com', uid: 'uid-silviachine@gmail.com' },
            docs: seedDocs({ centers: [center()], events: [studioEvent({ id: 'oggi', title: 'Appuntamento di oggi', start: `${today}T11:00:00`, end: `${today}T12:00:00` })] })
        }
    });

    test.beforeEach(async ({ page }) => {
        test.skip(!isMobile(page), 'Solo viewport mobile');
        await loginViaUi(page);
    });

    test('mostra la barra di navigazione inferiore e l’agenda settimanale', async ({ page }) => {
        const nav = page.locator('#mobile-admin-nav');
        await expect(nav).toBeVisible();
        await expect(nav.getByRole('button')).toHaveText(['Agenda', 'Pazienti', 'Appuntamento', 'Sincronizza', 'Altro']);
        await expect(page.locator('.fc-listWeek-view')).toBeVisible();
        await expect(page.locator('#calendar')).toContainText('Appuntamento di oggi');
    });

    test('il menu "Altro" si apre e si chiude (pulsante, Esc, sfondo)', async ({ page }) => {
        const more = page.locator('#mobile-admin-more');
        const open = () => page.locator('#mobile-admin-nav').getByRole('button', { name: 'Altro' }).click();
        await open();
        await expect(more).toHaveClass(/open/);
        await more.getByRole('button', { name: 'Chiudi' }).click();
        await expect(more).not.toHaveClass(/open/);
        await open();
        await page.keyboard.press('Escape');
        await expect(more).not.toHaveClass(/open/);
        await open();
        await more.click({ position: { x: 10, y: 10 } });
        await expect(more).not.toHaveClass(/open/);
        expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
    });

    test('aprendo una finestra la barra inferiore viene nascosta e poi ripristinata', async ({ page }) => {
        await page.locator('#mobile-admin-nav').getByRole('button', { name: 'Pazienti' }).click();
        await expect(page.locator('#patients-modal')).toBeVisible();
        await expect(page.locator('body')).toHaveClass(/modal-open/);
        await expect(page.locator('#mobile-admin-nav')).toBeHidden();
        await page.locator('#patients-modal button:has(.fa-xmark)').first().click();
        await expect(page.locator('#mobile-admin-nav')).toBeVisible();
    });

    test('il pulsante Agenda torna alla settimana corrente', async ({ page }) => {
        await page.locator('.fc-next-button').click();
        await expect(page.locator('#calendar')).not.toContainText('Appuntamento di oggi');
        await page.locator('#mobile-admin-nav').getByRole('button', { name: 'Agenda' }).click();
        await expect(page.locator('#calendar')).toContainText('Appuntamento di oggi');
    });

    test('nessuno scroll orizzontale nell’area riservata', async ({ page }) => {
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow).toBeLessThanOrEqual(0);
    });
});
