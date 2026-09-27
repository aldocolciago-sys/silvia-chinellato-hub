import { test, expect, loginViaUi, isMobile, firestore, localDate } from './fixtures.js';
import { seedDocs, center, patient, studioEvent, SHARED } from '../fixtures/seed.js';

const tomorrow = localDate(1);

test.use({
    firebaseSeed: {
        popupUser: { email: 'silviachine@gmail.com', uid: 'uid-silviachine@gmail.com' },
        docs: seedDocs({
            centers: [center({ id: 'cms', name: 'CMS - Carate Brianza', service: 'Idrocolonterapia' })],
            patients: [patient({ id: 'p1', name: 'Mario Rossi', phone: '333 1234567' }), patient({ id: 'p2', name: 'Anna Bianchi', phone: '' })],
            events: [
                studioEvent({ id: 'e1', title: 'Idrocolonterapia', start: `${tomorrow}T09:00:00`, end: `${tomorrow}T10:00:00`, extendedProps: { centerId: 'cms', centerName: 'CMS - Carate Brianza', patientId: 'p1' } }),
                studioEvent({ id: 'e2', title: 'Osteopatia', start: `${tomorrow}T15:00:00`, end: `${tomorrow}T16:00:00`, extendedProps: { patientId: 'p2' } })
            ]
        })
    }
});

test('invia il promemoria di domani su WhatsApp e lo segna come inviato', async ({ page }) => {
    await page.context().route('https://wa.me/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>WhatsApp</body></html>' }));
    await loginViaUi(page);
    if (isMobile(page)) {
        await page.locator('#mobile-admin-nav').getByRole('button', { name: 'Altro' }).click();
        await page.locator('#mobile-admin-more').getByRole('button', { name: 'Promemoria', exact: true }).click();
    } else {
        await page.locator('#private-view > header').getByTitle('Promemoria di domani', { exact: true }).click();
    }
    const modal = page.locator('#reminders-modal');
    await expect(modal).toBeVisible();
    await expect(page.locator('#reminders-summary')).toHaveText('2 appuntamenti • 1 promemoria da inviare');
    await expect(modal.locator('[data-reminder-id="e2"]')).toContainText('Telefono mancante');

    await modal.getByRole('button', { name: 'Promemoria WhatsApp a Mario Rossi' }).click();
    await expect(page.locator('#patient-message-modal')).toBeVisible();
    await expect(page.locator('#message-preview-text')).toHaveValue(/le ricordo la seduta di idrocolonterapia .* alle 09:00 presso CMS - Carate Brianza/);
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.locator('#message-send-btn').click()]);
    await popup.waitForLoadState();
    expect(new URL(popup.url()).pathname).toBe('/393331234567');
    await popup.close();

    await expect(page.locator('#patient-message-modal')).toBeHidden();
    await expect(modal.locator('[data-reminder-id="e1"]')).toContainText(/✓ inviato alle \d{2}:\d{2}/);
    await expect(page.locator('#reminders-summary')).toHaveText('2 appuntamenti • 0 promemoria da inviare');
    await expect.poll(async () => (await firestore(page).get(`${SHARED}/studio_events/e1`))?.extendedProps?.reminderSentAt).toBeTruthy();
});
