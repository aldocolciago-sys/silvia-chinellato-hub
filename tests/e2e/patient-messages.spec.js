import AxeBuilder from '@axe-core/playwright';
import { test, expect, loginViaUi, isMobile, firestore, localDate } from './fixtures.js';
import { seedDocs, center, patient, studioEvent, SHARED } from '../fixtures/seed.js';

const REVIEW_URL = 'https://g.page/r/silvia/review';

test.use({
    firebaseSeed: {
        popupUser: { email: 'silviachine@gmail.com', uid: 'uid-silviachine@gmail.com' },
        docs: seedDocs({
            centers: [center({ id: 'c1', name: 'Poliambulatorio San Benedetto', service: 'Idrocolonterapia' })],
            patients: [
                patient({ id: 'p1', name: 'Mario Rossi', phone: '333 1234567' }),
                patient({ id: 'p2', name: 'Anna Senza Telefono', phone: '' })
            ],
            events: [
                studioEvent({ id: 'e1', title: 'Seduta', start: `${localDate(-15)}T09:00:00`, end: `${localDate(-15)}T10:00:00`, extendedProps: { patientId: 'p1', centerId: 'c1', centerName: 'Poliambulatorio San Benedetto' } }),
                studioEvent({ id: 'e2', title: 'Seduta', start: `${localDate(4)}T15:00:00`, end: `${localDate(4)}T16:00:00`, extendedProps: { patientId: 'p1', centerId: 'c1', centerName: 'Poliambulatorio San Benedetto' } })
            ]
        })
    }
});

async function openPatients(page) {
    if (isMobile(page)) await page.locator('#mobile-admin-nav').getByRole('button', { name: 'Pazienti' }).click();
    else await page.getByTitle('Pazienti', { exact: true }).click();
    await expect(page.locator('#patients-modal')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
    // WhatsApp simulato: la nuova scheda viene intercettata, nessun messaggio reale
    await page.context().route('https://wa.me/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>WhatsApp</body></html>' }));
});

test('dal paziente si apre WhatsApp con il messaggio scelto e modificato', async ({ page }) => {
    await loginViaUi(page);
    await openPatients(page);
    const card = page.locator('#patients-alphabetical-list > div').filter({ hasText: 'Mario Rossi' });
    const whatsapp = card.getByRole('button', { name: 'Messaggio WhatsApp a Mario Rossi' });
    await expect(whatsapp).toBeVisible();
    await expect(page.locator('#patients-alphabetical-list > div').filter({ hasText: 'Anna Senza Telefono' }).getByRole('button', { name: /Messaggio WhatsApp/ })).toHaveCount(0);

    await whatsapp.click();
    const modal = page.locator('#patient-message-modal');
    await expect(modal).toBeVisible();
    await expect(page.locator('#patient-message-title')).toHaveText('Messaggio a Mario Rossi');
    await expect(page.locator('#message-treatment-idrocolonterapia')).toHaveAttribute('aria-pressed', 'true');
    if (isMobile(page)) await expect(page.locator('#mobile-admin-nav')).toBeHidden();

    await modal.getByRole('button', { name: /Promemoria appuntamento/ }).click();
    const text = page.locator('#message-preview-text');
    await expect(text).toHaveValue(/le ricordo la seduta di idrocolonterapia di .+ alle 15:00 presso Poliambulatorio San Benedetto\./);
    await modal.getByRole('button', { name: 'Osteopatia' }).click();
    await expect(text).toHaveValue(/l'appuntamento di osteopatia/);
    await text.fill('Gentile Mario Rossi, messaggio di prova.');

    const [popup] = await Promise.all([
        page.waitForEvent('popup'),
        modal.getByRole('button', { name: 'Apri WhatsApp' }).click()
    ]);
    await popup.waitForLoadState();
    const url = new URL(popup.url());
    expect(url.origin + url.pathname).toBe('https://wa.me/393331234567');
    expect(url.searchParams.get('text')).toBe('Gentile Mario Rossi, messaggio di prova.');
    await popup.close();

    await expect(modal).toBeHidden();
    await expect(page.locator('#toast-message')).toHaveText('WhatsApp aperto: contatto registrato.');
    expect(await firestore(page).get(`${SHARED}/patients_list/p1`)).toMatchObject({ lastContactType: 'reminder', lastContactTreatment: 'osteopatia' });
});

test('imposta il link recensioni e prepara l’invito', async ({ page }) => {
    await loginViaUi(page);
    await openPatients(page);
    await page.getByRole('button', { name: 'Messaggio WhatsApp a Mario Rossi' }).click();
    const modal = page.locator('#patient-message-modal');
    await expect(modal.getByRole('button', { name: /Recensione Google/ })).toBeDisabled();
    await modal.getByText('Impostazioni messaggi').click();
    await page.locator('#google-review-url').fill(REVIEW_URL);
    await modal.getByRole('button', { name: 'Salva link' }).click();
    await expect(page.locator('#toast-message')).toHaveText('Link recensioni salvato.');
    await expect(modal.getByRole('button', { name: /Recensione Google/ })).toBeEnabled();
    await modal.getByRole('button', { name: /Recensione Google/ }).click();
    await expect(page.locator('#message-preview-text')).toHaveValue(new RegExp(`Può farlo qui: ${REVIEW_URL.replace(/[/.]/g, '\\$&')}\\.`));
    await modal.getByRole('button', { name: 'Indietro' }).click();
    await expect(page.locator('#message-type-list')).toBeVisible();
});

test('tutti i controlli della finestra sono visibili, cliccabili e accessibili', async ({ page }) => {
    await loginViaUi(page);
    await openPatients(page);
    await page.getByRole('button', { name: 'Messaggio WhatsApp a Mario Rossi' }).click();
    const modal = page.locator('#patient-message-modal');
    await modal.getByText('Impostazioni messaggi').click();
    const viewport = page.viewportSize();
    for (const control of await modal.locator('button:not([disabled]), input, textarea').filter({ visible: true }).all()) {
        await control.scrollIntoViewIfNeeded();
        const box = await control.boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(-1);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
        await control.click({ trial: true });
    }
    await modal.getByRole('button', { name: /Richiesta notizie/ }).click();
    for (const control of await modal.locator('#message-preview-panel button, #message-preview-panel textarea').all()) {
        await control.scrollIntoViewIfNeeded();
        await control.click({ trial: true });
    }
    const results = await new AxeBuilder({ page }).include('#patient-message-modal').withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(results.violations.filter(v => ['critical', 'serious'].includes(v.impact)).map(v => `${v.id}: ${v.nodes.map(n => n.target).join(', ')}`)).toEqual([]);
    await modal.getByRole('button', { name: 'Chiudi' }).click();
    await expect(modal).toBeHidden();
});
