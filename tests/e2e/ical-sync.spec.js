/**
 * Sincronizzazione iCal end-to-end: browser → /api/ical (vera funzione serverless eseguita dal
 * server di test) → calendario .ics servito localmente. Nessun mock di rete lato applicazione.
 */
import { test, expect, loginViaUi, isMobile, firestore } from './fixtures.js';
import { seedDocs, center, patient, SHARED } from '../fixtures/seed.js';
import { vcalendar, vevent } from '../fixtures/ical.js';

const PORT = Number(process.env.E2E_PORT || 4173);
const ORIGIN = `http://127.0.0.1:${PORT}`;

function calendarKey(testInfo) {
    return `${testInfo.project.name}-${testInfo.title}`.replace(/[^\w-]+/g, '-').slice(0, 80);
}

async function publishCalendar(request, key, events) {
    const res = await request.put(`/__fixtures__/dynamic/${key}.ics`, { data: vcalendar(events.map(vevent)) });
    expect(res.status()).toBe(204);
}

async function syncNow(page) {
    if (isMobile(page)) await page.locator('#mobile-admin-nav').getByRole('button', { name: 'Sincronizza' }).click();
    else await page.getByRole('button', { name: 'Sincronizza Calendari' }).click();
    await expect(page.locator('#sync-modal-title')).toHaveText('Sincronizzazione completata');
}

test.describe('sincronizzazione calendari poliambulatori', () => {
    test('importa, aggiorna e gestisce gli appuntamenti rimossi alla fonte', async ({ page, request }, testInfo) => {
        const key = calendarKey(testInfo);
        await publishCalendar(request, key, [
            { uid: 'a', summary: 'Mario Rossi', start: '20300115T090000Z', end: '20300115T100000Z' },
            { uid: 'b', summary: 'Paziente da cancellare', start: '20300116T090000Z', end: '20300116T100000Z' }
        ]);
        await page.addInitScript(() => localStorage.clear());
        await page.addInitScript(seed => { window.__FIREBASE_MOCK_SEED__ = seed; }, {
            popupUser: { email: 'silviachine@gmail.com', uid: 'uid-silviachine@gmail.com' },
            docs: seedDocs({
                centers: [center({ id: 'c1', name: 'Polisalute', icalUrl: `${ORIGIN}/__fixtures__/dynamic/${key}.ics` })],
                patients: [patient({ id: 'pat_1', name: 'Mario Rossi' })]
            })
        });

        // 1) Sincronizzazione automatica al login
        await loginViaUi(page, { closeReport: false });
        await expect(page.locator('#sync-report-content')).toContainText('Aggiunti (2)');
        await expect(page.locator('#sync-report-content')).toContainText('Polisalute');
        await page.getByRole('button', { name: 'Ho capito' }).click();
        const imported = await firestore(page).get(`${SHARED}/studio_events/ical_c1_a`);
        expect(imported).toMatchObject({ title: 'Mario Rossi', start: '2030-01-15T09:00:00.000Z', extendedProps: { patientId: 'pat_1', centerName: 'Polisalute' } });

        // 2) Il poliambulatorio sposta un appuntamento e ne cancella un altro
        await publishCalendar(request, key, [{ uid: 'a', summary: 'Mario Rossi', start: '20300115T110000Z', end: '20300115T120000Z' }]);
        await syncNow(page);
        const content = page.locator('#sync-report-content');
        await expect(content).toContainText('Modificati (1)');
        await expect(content).toContainText('Rimossi dal calendario originale (1)');
        await expect(content).toContainText('Scelta obbligatoria');
        const close = page.locator('#sync-modal-footer button');
        await expect(close).toBeDisabled();
        await expect(close).toHaveText('Completa 1 scelte');

        // 3) Decisione: mantenere l'appuntamento nell'agenda personale
        await content.getByRole('button', { name: 'Mantieni nella mia agenda' }).click();
        await expect(page.locator('#confirm-text')).toContainText('mantenere definitivamente');
        await page.getByRole('button', { name: 'Sì, mantieni' }).click();
        await expect(content).toContainText('Scelta registrata: mantieni nella mia agenda');
        await expect(close).toBeEnabled();
        await close.click();
        await expect(page.locator('#sync-report-modal')).toBeHidden();

        const kept = await firestore(page).get(`${SHARED}/studio_events/ical_c1_b`);
        expect(kept.extendedProps.detachedFromExternal).toBe(true);
        expect((await firestore(page).get(`${SHARED}/studio_events/ical_c1_a`)).start).toBe('2030-01-15T11:00:00.000Z');

        // 4) Il report resta consultabile da "Ultime novità"
        if (isMobile(page)) {
            await page.locator('#mobile-admin-nav').getByRole('button', { name: 'Altro' }).click();
            await page.locator('#mobile-admin-more').getByRole('button', { name: 'Ultime novità' }).click();
        } else {
            await page.getByRole('button', { name: 'Ultime novità' }).click();
        }
        await expect(page.locator('#sync-modal-title')).toHaveText('Novità dell’ultima sincronizzazione');
        await expect(content).toContainText('Modificati (1)');
    });

    test('rimuove dall’agenda un appuntamento cancellato alla fonte', async ({ page, request }, testInfo) => {
        const key = calendarKey(testInfo);
        await publishCalendar(request, key, [{ uid: 'x', summary: 'Da rimuovere', start: '20300201T090000Z' }]);
        await page.addInitScript(seed => { window.__FIREBASE_MOCK_SEED__ = seed; }, {
            popupUser: { email: 'silviachine@gmail.com', uid: 'uid-silviachine@gmail.com' },
            docs: seedDocs({ centers: [center({ id: 'c1', name: 'Polisalute', icalUrl: `${ORIGIN}/__fixtures__/dynamic/${key}.ics` })] })
        });
        await loginViaUi(page);
        await publishCalendar(request, key, []);
        await syncNow(page);
        await page.getByRole('button', { name: 'Rimuovi dalla mia agenda' }).click();
        await page.getByRole('button', { name: 'Sì, rimuovi' }).click();
        await expect(page.locator('#sync-report-content')).toContainText('Scelta registrata: rimuovi dalla mia agenda');
        expect(await firestore(page).has(`${SHARED}/studio_events/ical_c1_x`)).toBe(false);
    });

    test('configura un calendario dalla gestione poliambulatori e lo sincronizza', async ({ page }) => {
        await loginViaUi(page);
        if (isMobile(page)) {
            await page.locator('#mobile-admin-nav').getByRole('button', { name: 'Altro' }).click();
            await page.locator('#mobile-admin-more').getByRole('button', { name: 'Poliambulatori' }).click();
        } else {
            await page.getByTitle('Gestisci Poliambulatori').click();
        }
        await expect(page.locator('#centers-modal')).toBeVisible();
        await page.locator('#new-center-name').fill('Studio Fixture');
        await page.locator('#new-center-service').fill('Osteopatia');
        await page.locator('#new-center-ical').fill(`${ORIGIN}/__fixtures__/polisalute.ics`);
        await page.getByRole('button', { name: 'Salva Poliambulatorio' }).click();
        await expect(page.locator('#centers-management-list')).toContainText('Studio Fixture');
        await expect(page.locator('#centers-management-list')).toContainText('iCal attivo');
        await page.locator('#centers-modal button:has(.fa-xmark)').first().click();
        await syncNow(page);
        await expect(page.locator('#sync-report-content')).toContainText('Aggiunti (2)');
        await expect(page.locator('#sync-report-content')).toContainText('Giulia Bianchi');
    });

    test('un calendario non valido non importa eventi e mostra l’errore', async ({ page }) => {
        await page.addInitScript(seed => { window.__FIREBASE_MOCK_SEED__ = seed; }, {
            popupUser: { email: 'silviachine@gmail.com', uid: 'uid-silviachine@gmail.com' },
            docs: seedDocs({ centers: [center({ id: 'c1', name: 'Privato', icalUrl: `${ORIGIN}/__fixtures__/not-a-calendar.ics` })] })
        });
        await loginViaUi(page, { closeReport: false });
        await expect(page.locator('#sync-report-content')).toContainText('Privato');
        await expect(page.locator('#sync-report-content')).toContainText('Errore di sincronizzazione');
        await expect(page.locator('#sync-report-content')).not.toContainText('Nessuna variazione');
        expect(await firestore(page).list(`${SHARED}/studio_events`)).toEqual([]);
    });
});
