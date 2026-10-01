import { test, expect, loginViaUi, isMobile, firestore } from './fixtures.js';
import AxeBuilder from '@axe-core/playwright';
import { seedDocs, center, patient, studioEvent, SHARED } from '../fixtures/seed.js';

test.use({
    firebaseSeed: {
        popupUser: { email: 'silviachine@gmail.com', uid: 'uid-silviachine@gmail.com' },
        docs: seedDocs({
            centers: [center({ id: 'cms', name: 'CMS - Carate Brianza', service: 'Idrocolonterapia' })],
            patients: [patient({ id: 'p1', name: 'Mario Rossi', phone: '333 1234567' }), patient({ id: 'p2', name: 'Anna Bianchi', phone: '' })],
            events: [
                studioEvent({ id: 'passato', title: 'Osteopatia', start: '2030-03-04T09:00:00', end: '2030-03-04T10:00:00', extendedProps: { patientId: 'p1' } }),
                studioEvent({ id: 'oggi', title: 'Osteopatia', start: '2030-03-04T16:00:00', end: '2030-03-04T17:00:00', extendedProps: { patientId: 'p1' } }),
                studioEvent({ id: 'e1', title: 'Idrocolonterapia', start: '2030-03-05T09:00:00', end: '2030-03-05T10:00:00', extendedProps: { centerId: 'cms', centerName: 'CMS - Carate Brianza', patientId: 'p1' } }),
                studioEvent({ id: 'e2', title: 'Osteopatia', start: '2030-03-05T15:00:00', end: '2030-03-05T16:00:00', extendedProps: { patientId: 'p2' } })
            ]
        })
    }
});

test('promemoria di oggi e domani: invio su WhatsApp e stato "inviato"', async ({ page }) => {
    // lunedì 4 marzo 2030, ore 12:00 a Roma; poi il tempo scorre normalmente
    await page.clock.install({ time: new Date('2030-03-04T12:00:00+01:00') });
    await page.context().route('https://wa.me/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>WhatsApp</body></html>' }));
    await loginViaUi(page);
    if (isMobile(page)) {
        await page.locator('#mobile-admin-nav').getByRole('button', { name: 'Altro' }).click();
        await page.locator('#mobile-admin-more').getByRole('button', { name: 'Promemoria', exact: true }).click();
    } else {
        await page.locator('#private-view > header').getByTitle('Promemoria di oggi e domani', { exact: true }).click();
    }
    const modal = page.locator('#reminders-modal');
    await expect(modal).toBeVisible();
    await expect(page.locator('#reminders-summary')).toHaveText('3 appuntamenti • 2 promemoria da inviare');
    await expect(modal.locator('[data-reminder-section="today"] [data-reminder-id]')).toHaveCount(1);
    await expect(modal.locator('[data-reminder-section="tomorrow"] [data-reminder-id]')).toHaveCount(2);
    await expect(modal.locator('[data-reminder-id="e2"]')).toContainText('Telefono mancante');

    await modal.getByRole('button', { name: 'Promemoria WhatsApp a Mario Rossi (09:00)' }).click();
    await expect(page.locator('#patient-message-modal')).toBeVisible();
    await expect(page.locator('#message-preview-text')).toHaveValue(/le ricordo la seduta di idrocolonterapia di martedì 5 marzo alle 09:00 presso CMS - Carate Brianza/);
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.locator('#message-send-btn').click()]);
    await popup.waitForLoadState();
    expect(new URL(popup.url()).pathname).toBe('/393331234567');
    await popup.close();

    await expect(page.locator('#patient-message-modal')).toBeHidden();
    await expect(modal.locator('[data-reminder-id="e1"]')).toContainText(/✓ inviato alle \d{2}:\d{2}/);
    await expect(page.locator('#reminders-summary')).toHaveText('3 appuntamenti • 1 promemoria da inviare');
    await expect.poll(async () => (await firestore(page).get(`${SHARED}/studio_events/e1`))?.extendedProps?.reminderSentAt).toBeTruthy();

    await modal.getByRole('button', { name: 'Promemoria WhatsApp a Mario Rossi (16:00)' }).click();
    await expect(page.locator('#message-preview-text')).toHaveValue(/l'appuntamento di osteopatia di lunedì 4 marzo alle 16:00/);
});

test('riepilogo automatico delle 7:00: attivazione, prova e accessibilità', async ({ page }) => {
    const requests = [];
    await page.route('**/api/daily-reminder', async route => {
        requests.push({ method: route.request().method(), auth: route.request().headers().authorization });
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'sent' }) });
    });
    await loginViaUi(page);
    await page.evaluate(() => window.openRemindersModal());
    const panel = page.locator('#daily-digest-panel');
    await panel.scrollIntoViewIfNeeded();
    await expect(panel.locator('#daily-digest-status')).toHaveText('Disattivato.');

    const axe = await new AxeBuilder({ page }).include('#daily-digest-panel').withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(axe.violations.map(v => v.id)).toEqual([]);

    await panel.getByLabel('Ogni mattina invia questo promemoria sul WhatsApp di Silvia').check();
    await expect(page.locator('#toast-message')).toHaveText('Riepilogo delle 7:00 attivato.');
    await expect.poll(async () => (await firestore(page).get(`${SHARED}/settings/messaging`))?.dailyDigestEnabled).toBe(true);
    await expect(panel.locator('#daily-digest-status')).toHaveText('Attivo: il primo riepilogo arriverà domattina alle 7.');

    await panel.getByRole('button', { name: 'Invia una prova ora' }).click();
    await expect(page.locator('#toast-message')).toHaveText('Prova inviata: controlla WhatsApp.');
    expect(requests).toEqual([{ method: 'POST', auth: 'Bearer mock-id-token:silviachine@gmail.com' }]);
});
