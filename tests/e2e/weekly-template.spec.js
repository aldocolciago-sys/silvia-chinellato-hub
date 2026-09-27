import { test, expect, loginViaUi, isMobile, firestore, localDate } from './fixtures.js';
import { seedDocs, center, studioEvent, SHARED } from '../fixtures/seed.js';

const today = localDate(0);
const weekday = new Date(`${today}T12:00:00`).getDay();

test.use({
    firebaseSeed: {
        popupUser: { email: 'silviachine@gmail.com', uid: 'uid-silviachine@gmail.com' },
        docs: seedDocs({
            centers: [center({ id: 'cms', name: 'CMS - Carate Brianza', service: 'Idrocolonterapia', color: '#4a8fa8' })],
            events: [
                studioEvent({ id: 'a', title: 'Paziente CMS', start: `${today}T09:00:00`, end: `${today}T10:00:00`, extendedProps: { centerId: 'cms' } }),
                studioEvent({ id: 'b', title: 'Paziente studio', start: `${today}T10:20:00`, end: `${today}T11:20:00` })
            ]
        })
    }
});

async function openAgendaSettings(page) {
    if (isMobile(page)) {
        await page.locator('#mobile-admin-nav').getByRole('button', { name: 'Altro' }).click();
        await page.locator('#mobile-admin-more').getByRole('button', { name: 'Settimana tipo', exact: true }).click();
    } else {
        await page.locator('#private-view > header').getByTitle('Settimana tipo e spostamenti', { exact: true }).click();
    }
    await expect(page.locator('#agenda-settings-modal')).toBeVisible();
}

test('spostamento stretto tra due sedi: banner e appuntamento evidenziato', async ({ page }) => {
    await loginViaUi(page);
    await expect(page.locator('#calendar-transfer-banner')).toBeVisible();
    await expect(page.locator('#transfer-banner-text')).toHaveText('⏱ 1 spostamento stretto: meno di 45 minuti tra due sedi diverse.');
    await page.locator('#calendar-transfer-banner').getByRole('button', { name: 'Verifica' }).click();
    await expect(page.locator('#calendar')).toContainText('⏱ [SPOSTAMENTO] Paziente studio');
});

test('imposta la settimana tipo, vede le fasce e l\'avviso nel modulo', async ({ page }) => {
    await loginViaUi(page);
    await openAgendaSettings(page);
    await page.getByRole('button', { name: 'Aggiungi fascia' }).click();
    await page.locator('#slot-weekday-0').selectOption(String(weekday));
    await page.locator('#slot-center-0').selectOption('cms');
    await page.locator('#slot-from-0').fill('08:00');
    await page.locator('#slot-to-0').fill('13:00');
    // ogni controllo della riga è visibile e dentro lo schermo (anche su mobile)
    const viewport = page.viewportSize();
    for (const id of ['#slot-weekday-0', '#slot-center-0', '#slot-from-0', '#slot-to-0']) {
        const box = await page.locator(id).boundingBox();
        expect(box.x + box.width, id).toBeLessThanOrEqual(viewport.width);
    }
    await page.locator('#agenda-travel-minutes').fill('15');
    await page.getByRole('button', { name: 'Salva settimana tipo' }).click();
    await expect(page.locator('#agenda-settings-modal')).toBeHidden();
    await expect.poll(async () => (await firestore(page).get(`${SHARED}/settings/agenda`))?.weeklyTemplate).toEqual([{ weekday, centerId: 'cms', from: '08:00', to: '13:00' }]);
    await expect(page.locator('#calendar-transfer-banner')).toBeHidden(); // 20 minuti bastano con soglia 15

    if (!isMobile(page)) {
        await page.locator('#calendar').getByRole('button', { name: 'Settimana', exact: true }).click();
        await expect(page.locator('#calendar .fc-bg-event').first()).toBeVisible();
    }

    // appuntamento in studio durante la fascia del poliambulatorio → avviso non bloccante
    if (isMobile(page)) await page.locator('#mobile-admin-nav').getByRole('button', { name: 'Appuntamento' }).click();
    else await page.getByRole('button', { name: 'Studio', exact: true }).click();
    await page.locator('#studio-date').fill(today);
    await page.locator('#studio-time-start').selectOption('11:00');
    await expect(page.locator('#studio-template-hint')).toBeVisible();
    await expect(page.locator('#studio-template-hint')).toContainText('sei presso CMS - Carate Brianza');
    await page.locator('#studio-center-select').selectOption('cms');
    await expect(page.locator('#studio-template-hint')).toBeHidden();
});
