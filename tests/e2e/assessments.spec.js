import { test, expect, loginViaUi, isMobile, firestore } from './fixtures.js';
import { seedDocs, center, patient, SHARED } from '../fixtures/seed.js';

test.use({
    firebaseSeed: {
        popupUser: { email: 'silviachine@gmail.com', uid: 'uid-silviachine@gmail.com' },
        docs: seedDocs({
            centers: [center({ id: 'cms', name: 'CMS - Carate Brianza', service: 'Idrocolonterapia' })],
            patients: [patient({ id: 'p1', name: 'Mario Rossi', phone: '333 1234567' })]
        })
    }
});

test('valutazione pre-trattamento: avviso nel modulo e compilazione della scheda', async ({ page }) => {
    await loginViaUi(page);
    if (isMobile(page)) await page.locator('#mobile-admin-nav').getByRole('button', { name: 'Appuntamento' }).click();
    else await page.getByRole('button', { name: 'Studio', exact: true }).click();
    await page.locator('#studio-center-select').selectOption('cms');
    await page.locator('#studio-patient-select').selectOption('p1');
    const warning = page.locator('#studio-assessment-warning');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('Valutazione pre-trattamento per Idrocolonterapia mancante');

    await warning.getByRole('button', { name: 'Apri valutazione' }).click();
    const modal = page.locator('#patient-edit-modal');
    await expect(modal).toBeVisible();
    const idro = modal.locator('#assessment-idrocolonterapia');
    await idro.locator('summary').click();
    await idro.getByRole('button', { name: 'Segna tutte "No"' }).click();
    const item = idro.locator('[data-assessment-item="ernia"]');
    await item.getByText('Sì', { exact: true }).click();
    await item.getByPlaceholder('Nota (facoltativa)').fill('Ernia inguinale operata nel 2020');
    await idro.getByText('Verificato da Silvia').click();

    // tutti i controlli della lista sono dentro lo schermo (anche su mobile)
    const viewport = page.viewportSize();
    for (const box of await idro.locator('input, button').evaluateAll(els => els.map(e => e.getBoundingClientRect().toJSON()))) {
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    }

    await modal.getByRole('button', { name: 'Salva Paziente' }).click();
    await expect(modal).toBeHidden();
    await expect(page.locator('#studio-modal')).toBeVisible();
    await expect(warning).toContainText('Controindicazioni da verificare (Idrocolonterapia): Ernia addominale o inguinale.');
    await expect(page.locator('#studio-center-select')).toHaveValue('cms');
    await expect(page.locator('#studio-treatment')).toHaveValue('idrocolonterapia');

    // cambiando il trattamento l'avviso segue la valutazione corrispondente
    await page.locator('#studio-treatment').selectOption('osteopatia');
    await expect(warning).toContainText('Valutazione pre-trattamento per Osteopatia mancante');

    const saved = await firestore(page).get(`${SHARED}/patients_list/p1`);
    expect(saved.assessments.idrocolonterapia).toMatchObject({ verified: true });
    expect(saved.assessments.idrocolonterapia.items.ernia).toEqual({ answer: 'yes', note: 'Ernia inguinale operata nel 2020' });
});
