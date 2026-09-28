import { test, expect, loginViaUi, firestore } from './fixtures.js';
import { seedDocs, studioEvent, SHARED } from '../fixtures/seed.js';
import AxeBuilder from '@axe-core/playwright';

test.use({
    firebaseSeed: {
        popupUser: { email: 'silviachine@gmail.com', uid: 'uid-silviachine@gmail.com' },
        docs: seedDocs({
            events: [1, 2, 3].map(i => studioEvent({ id: `e${i}`, title: 'Seduta', start: `2029-0${i}-10T09:00:00`, end: `2029-0${i}-10T10:00:00`, extendedProps: { fee: 10000 } })),
            extra: { [`${SHARED}/tax_profile/default`]: { profitabilityCoefficient: 78, substituteTaxRate: 5, inpsRate: 26.07, advanceRate: 100, updatedAt: 'x' } }
        })
    }
});

test('promemoria della scadenza fiscale e scadenziario nella dashboard', async ({ page }) => {
    await page.clock.install({ time: new Date('2030-06-20T10:00:00+02:00') });
    await loginViaUi(page);
    const banner = page.locator('#tax-deadline-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Scadenza fiscale tra 11 giorni (1 luglio)');

    await banner.getByRole('button', { name: 'Dettagli' }).click();
    await expect(page.locator('#business-dashboard-modal')).toBeVisible();
    const schedule = page.locator('#tax-schedule-section');
    await expect(schedule).toBeInViewport();
    await expect(page.locator('#tax-schedule-title')).toHaveText('Scadenze fiscali 2030');
    await expect(schedule.locator('[data-tax-deadline]')).toHaveCount(2);
    await expect(schedule.locator('[data-tax-deadline="2030-07-01"]')).toContainText('Saldo imposta sostitutiva 2029');

    const results = await new AxeBuilder({ page }).include('#tax-schedule-section').withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(results.violations.map(v => v.id)).toEqual([]);

    // cassa con date personalizzate
    await page.locator('#tax-pension-fund').selectOption('custom');
    await page.locator('#tax-custom-0-label').fill('Saldo ENPAPI');
    await page.locator('#tax-custom-0-day').fill('30/09');
    await page.locator('#tax-custom-0-percent').fill('100');
    await page.getByRole('button', { name: 'Salva profilo fiscale' }).click();
    await expect(schedule.locator('[data-tax-deadline="2030-09-30"]')).toContainText('Saldo ENPAPI');
    await expect.poll(async () => (await firestore(page).get(`${SHARED}/tax_profile/default`))?.pensionFund).toBe('custom');

    await page.locator('#business-dashboard-modal').getByRole('button', { name: 'Chiudi' }).first().click();
    await banner.getByRole('button', { name: 'Nascondi promemoria scadenza' }).click();
    await expect(banner).toBeHidden();
});
