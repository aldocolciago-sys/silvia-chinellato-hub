import { test, expect, openSite, isMobile, firestore } from './fixtures.js';
import { seedDocs, APP_ID, SHARED } from '../fixtures/seed.js';
import AxeBuilder from '@axe-core/playwright';

const REQUESTS = `artifacts/${APP_ID}/requests`;

test.use({
    firebaseSeed: {
        popupUser: { email: 'silviachine@gmail.com', uid: 'uid-silviachine@gmail.com' },
        docs: seedDocs({})
    }
});

test('un visitatore invia una richiesta e Silvia la trasforma in appuntamento', async ({ page }) => {
    await openSite(page);
    const form = page.locator('#appointment-request-form');
    await form.scrollIntoViewIfNeeded();
    await expect(page.getByRole('heading', { name: 'Richiedi un appuntamento in studio' })).toBeVisible();

    const axe = await new AxeBuilder({ page }).include('#appointment-request').withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(axe.violations.map(v => v.id)).toEqual([]);

    // il campo antispam non è visibile né raggiungibile
    await expect(page.locator('#request-website')).not.toBeInViewport();

    await form.getByLabel('Nome e cognome *').fill('Anna Bianchi');
    await form.getByLabel('Telefono *').fill('333 7654321');
    await form.getByLabel('Giorni preferiti').fill('martedì');
    await form.getByLabel('Fascia preferita').selectOption('pomeriggio');
    await form.getByLabel('Messaggio (facoltativo)').fill('Mal di schiena da due settimane');
    await form.getByRole('button', { name: 'Invia la richiesta' }).click();
    await expect(page.locator('#request-feedback')).toContainText('serve il consenso');

    await form.getByLabel(/Acconsento al trattamento dei miei dati/).check();
    await page.waitForTimeout(3100); // chi compila davvero impiega più di 3 secondi (antispam)
    await form.getByRole('button', { name: 'Invia la richiesta' }).click();
    await expect(page.locator('#request-feedback')).toHaveText('Grazie! La richiesta è stata inviata: Silvia la ricontatterà al più presto.');
    await expect.poll(async () => (await firestore(page).list(REQUESTS)).length).toBe(1);

    // area riservata (senza ricaricare la pagina: il database simulato vive nella pagina)
    await page.getByRole('button', { name: 'Area Riservata' }).click();
    await page.getByRole('button', { name: 'Accedi con Google' }).click();
    await expect(page.locator('#sync-modal-title')).toHaveText('Sincronizzazione completata');
    await page.locator('#sync-modal-footer button').click();
    if (isMobile(page)) {
        await page.locator('#mobile-admin-nav').getByRole('button', { name: 'Altro' }).click();
        await expect(page.locator('#requests-badge-mobile')).toHaveText('1');
        await page.locator('#mobile-admin-more').getByRole('button', { name: /^Richieste/ }).click();
    } else {
        await expect(page.locator('#requests-badge')).toHaveText('1');
        await page.locator('#private-view > header').getByTitle('Richieste di appuntamento', { exact: true }).click();
    }
    const modal = page.locator('#requests-modal');
    await expect(modal).toContainText('Anna Bianchi');
    await expect(modal).toContainText('Mal di schiena da due settimane');
    await modal.getByRole('button', { name: 'Crea paziente e appuntamento' }).click();

    const patientModal = page.locator('#patient-edit-modal');
    await expect(patientModal).toBeVisible();
    await expect(page.locator('#patient-phone')).toHaveValue('333 7654321');
    await patientModal.getByRole('button', { name: 'Salva Paziente' }).click();
    await expect(patientModal).toBeHidden();
    await expect(page.locator('#studio-treatment')).toHaveValue('osteopatia');
    await page.locator('#studio-time-start').selectOption('15:00');
    await page.getByRole('button', { name: 'Salva Appuntamento' }).click();
    await expect(page.locator('#studio-modal')).toBeHidden();

    await expect.poll(async () => (await firestore(page).list(REQUESTS))[0]?.status).toBe('converted');
    await expect.poll(async () => (await firestore(page).list(`${SHARED}/patients_list`)).map(p => p.name)).toContain('Anna Bianchi');
});
