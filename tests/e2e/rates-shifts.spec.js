import { test, expect, loginViaUi, isMobile, firestore, localDate } from './fixtures.js';
import { seedDocs, center, SHARED } from '../fixtures/seed.js';

const today = localDate(0);

test.use({
    firebaseSeed: {
        popupUser: { email: 'silviachine@gmail.com', uid: 'uid-silviachine@gmail.com' },
        docs: seedDocs({
            centers: [
                center({ id: 'cms', name: 'CMS - Carate Brianza', service: 'Idrocolonterapia' }),
                center({ id: 'sport', name: 'Medicina dello Sport', service: 'Turni', isNonClinicalCalendar: true, showPublic: false, includeInFinance: false })
            ]
        })
    }
});

async function openCenters(page) {
    if (isMobile(page)) {
        await page.locator('#mobile-admin-nav').getByRole('button', { name: 'Altro' }).click();
        await page.locator('#mobile-admin-more button').filter({ hasText: 'Poliambulatori' }).click();
    } else {
        await page.getByTitle('Gestisci Poliambulatori', { exact: true }).click();
    }
    await expect(page.locator('#centers-modal')).toBeVisible();
}

async function openNewAppointment(page) {
    if (isMobile(page)) await page.locator('#mobile-admin-nav').getByRole('button', { name: 'Appuntamento' }).click();
    else await page.getByRole('button', { name: 'Studio', exact: true }).click();
    await expect(page.locator('#studio-modal')).toBeVisible();
}

test('imposta tariffe e turni, poi il compenso si compila da solo', async ({ page }) => {
    await loginViaUi(page);
    await openCenters(page);

    // tariffa del poliambulatorio
    await page.locator('#centers-management-list > div').filter({ hasText: 'CMS - Carate Brianza' }).getByRole('button', { name: 'Modifica' }).click();
    await page.locator('#new-center-rate-idrocolonterapia').fill('40');
    await page.getByRole('button', { name: 'Aggiorna' }).click();
    await expect(page.locator('#centers-management-list')).toContainText('Idro 40,00');

    // Medicina dello Sport a turni
    await page.locator('#centers-management-list > div').filter({ hasText: 'Medicina dello Sport' }).getByRole('button', { name: 'Modifica' }).click();
    await expect(page.locator('#center-shift-block')).toBeVisible();
    await page.locator('#new-center-shift').check();
    await page.locator('#new-center-hourly-rate').fill('25');
    await page.getByRole('button', { name: 'Aggiorna' }).click();
    await expect(page.locator('#centers-management-list')).toContainText('Turni 25,00');
    await page.locator('#centers-modal').getByRole('button', { name: 'Chiudi' }).first().click();

    // appuntamento al poliambulatorio: 40 € in automatico
    await openNewAppointment(page);
    await page.locator('#studio-center-select').selectOption('cms');
    await expect(page.locator('#studio-fee')).toHaveValue('40');
    await expect(page.locator('#studio-fee-hint')).toBeVisible();
    await page.locator('#studio-title').fill('Marco Colombo');
    await page.locator('#studio-date').fill(today);
    await page.getByRole('button', { name: 'Salva Appuntamento' }).click();
    await expect(page.locator('#toast-message')).toHaveText('Appuntamento salvato con successo!');

    // turno: 8-13 × 25 €/h = 125 €
    await openNewAppointment(page);
    await page.locator('#studio-center-select').selectOption('sport');
    await expect(page.locator('#studio-patient-section')).toBeHidden();
    await page.locator('#studio-title').fill('Turno ambulatorio');
    await page.locator('#studio-date').fill(today);
    await page.locator('#studio-time-start').selectOption('08:00');
    await page.locator('#studio-time-end').selectOption('13:00');
    await expect(page.locator('#studio-fee')).toHaveValue('125');
    await page.getByRole('button', { name: 'Salva Appuntamento' }).click();
    await expect(page.locator('#toast-message')).toHaveText('Appuntamento salvato con successo!');

    const events = await firestore(page).list(`${SHARED}/studio_events`);
    expect(events.map(e => e.extendedProps.fee).sort((a, b) => a - b)).toEqual([40, 125]);

    // dashboard compensi con i turni
    if (isMobile(page)) {
        await page.locator('#mobile-admin-nav').getByRole('button', { name: 'Altro' }).click();
        await page.locator('#mobile-admin-more button').filter({ hasText: 'Compensi' }).click();
    } else {
        await page.getByTitle('Dashboard compensi', { exact: true }).click();
    }
    await expect(page.locator('#business-shifts-section')).toBeVisible();
    await expect(page.locator('#business-shifts')).toContainText('5 h');
    await expect(page.locator('#business-kpis')).toContainText('165,00');
});
