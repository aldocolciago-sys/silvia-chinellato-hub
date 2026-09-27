import { readFile } from 'node:fs/promises';
import { test, expect, loginViaUi, isMobile, firestore, localDate } from './fixtures.js';
import { seedDocs, center, patient, studioEvent, SHARED, PUBLIC } from '../fixtures/seed.js';

/** Apre una funzione amministrativa dall'header (desktop) o dal menu "Altro" (mobile). */
async function openAdmin(page, { title, mobileLabel }) {
    if (isMobile(page)) {
        await page.locator('#mobile-admin-nav').getByRole('button', { name: 'Altro' }).click();
        await page.locator('#mobile-admin-more').getByRole('button', { name: mobileLabel }).click();
    } else {
        await page.getByTitle(title, { exact: true }).click();
    }
}

async function openPatients(page) {
    if (isMobile(page)) await page.locator('#mobile-admin-nav').getByRole('button', { name: 'Pazienti' }).click();
    else await page.getByTitle('Pazienti', { exact: true }).click();
    await expect(page.locator('#patients-modal')).toBeVisible();
}

const month = localDate(0).slice(0, 7);

test.use({
    firebaseSeed: {
        popupUser: { email: 'silviachine@gmail.com', uid: 'uid-silviachine@gmail.com' },
        docs: seedDocs({
            centers: [center({ id: 'c1', name: 'Centro Polisalute' })],
            patients: [
                patient({ id: 'p1', name: 'Mario Rossi', phone: '333 111', tags: ['cervicale'] }),
                patient({ id: 'p2', name: 'Mario Rosi', phone: '333111' }),
                patient({ id: 'p3', name: 'Giulia Bianchi', email: 'giulia@example.com' })
            ],
            events: [
                studioEvent({ id: 'e1', title: 'Visita / Trattamento - Mario Rossi', start: `${month}-02T09:00:00`, end: `${month}-02T10:00:00`, extendedProps: { patientId: 'p1', fee: 60, paymentStatus: 'paid', centerId: 'c1', centerName: 'Centro Polisalute' } }),
                studioEvent({ id: 'e2', title: 'Senza compenso', start: `${month}-03T09:00:00`, end: `${month}-03T10:00:00`, extendedProps: { patientId: 'p3', fee: 0 } })
            ]
        })
    }
});

test.describe('anagrafica pazienti', () => {
    test('crea un paziente e lo ritrova con la ricerca', async ({ page }) => {
        await loginViaUi(page);
        await openPatients(page);
        await page.locator('#patients-modal').getByRole('button', { name: /Nuovo Paziente/ }).click();
        await expect(page.locator('#patient-edit-modal')).toBeVisible();
        await page.locator('#patient-name').fill('Anna Verdi');
        await page.locator('#patient-phone').fill('340 555 1234');
        await page.locator('#patient-tags').fill('postura, sportiva');
        await page.getByRole('button', { name: 'Salva Paziente' }).click();
        await expect(page.locator('#toast-message')).toHaveText('Paziente salvato con successo!');
        await page.locator('#patient-search-input').fill('sportiva');
        await expect(page.locator('#patients-alphabetical-list > div')).toHaveCount(1);
        await expect(page.locator('#patients-alphabetical-list')).toContainText('Anna Verdi');
        const saved = (await firestore(page).list(`${SHARED}/patients_list`)).find(p => p.name === 'Anna Verdi');
        expect(saved.tags).toEqual(['postura', 'sportiva']);
    });

    test('espande la scheda e apre lo storico', async ({ page }) => {
        await loginViaUi(page);
        await openPatients(page);
        await page.locator('#patients-alphabetical-list').getByRole('button', { name: /Giulia Bianchi/ }).click();
        await expect(page.locator('#patients-alphabetical-list')).toContainText('PROSSIMO APPUNTAMENTO');
        const card = page.locator('#patients-alphabetical-list > div').filter({ hasText: 'Giulia Bianchi' });
        await card.getByRole('button', { name: 'Storico' }).filter({ visible: true }).first().click();
        await expect(page.locator('#patient-history-modal')).toBeVisible();
        await expect(page.locator('#patient-history-title')).toHaveText('Storico: Giulia Bianchi');
        await expect(page.locator('#patient-history-list')).toContainText('Senza compenso');
    });

    test('unisce due schede duplicate', async ({ page }) => {
        await loginViaUi(page);
        await openPatients(page);
        await page.locator('#patients-modal').getByRole('button', { name: /Unisci/ }).click();
        await expect(page.locator('#merge-patients-modal')).toBeVisible();
        await page.locator('#merge-suggestions button').first().click();
        await expect(page.locator('#merge-summary')).toContainText('verrà eliminata');
        await page.getByRole('button', { name: 'Conferma unione' }).click();
        await expect(page.locator('#toast-message')).toHaveText('Pazienti uniti con successo.');
        const remaining = await firestore(page).list(`${SHARED}/patients_list`);
        expect(remaining.map(p => p.name).sort()).toEqual(['Giulia Bianchi', 'Mario Rossi']);
    });
});

test.describe('compensi', () => {
    test('mostra i KPI del mese e completa un appuntamento senza compenso', async ({ page }) => {
        await loginViaUi(page);
        await openAdmin(page, { title: 'Dashboard compensi', mobileLabel: 'Compensi' });
        await expect(page.locator('#business-dashboard-modal')).toBeVisible();
        await expect(page.locator('#business-kpis')).toContainText('Appuntamenti');
        await expect(page.locator('#business-kpis')).toContainText('60,00');
        await expect(page.locator('#business-missing-fee-count')).toHaveText('1 da completare');
        await page.locator('#business-missing-fee-list button').first().click();
        await expect(page.locator('#studio-modal')).toBeVisible();
        await page.locator('#studio-fee').fill('45');
        await page.getByRole('button', { name: 'Salva Appuntamento' }).click();
        await expect(page.locator('#business-dashboard-modal')).toBeVisible();
        await expect(page.locator('#business-missing-fee-count')).toHaveText('0 da completare');
        await expect(page.locator('#business-kpis')).toContainText('105,00');
    });

    test('aggiunge un’entrata manuale e salva il profilo fiscale', async ({ page }) => {
        await loginViaUi(page);
        await openAdmin(page, { title: 'Dashboard compensi', mobileLabel: 'Compensi' });
        await page.locator('#manual-revenue-amount').fill('1200');
        await page.locator('#manual-revenue-description').fill('Fatture gennaio');
        await page.locator('#manual-revenue-form button[type="submit"]').click();
        await expect(page.locator('#toast-message')).toHaveText('Entrata manuale aggiunta.');
        await expect(page.locator('#manual-revenue-list')).toContainText('Fatture gennaio');
        await page.locator('#tax-previous-revenue').fill('30000');
        await page.getByRole('button', { name: 'Salva profilo fiscale' }).click();
        await expect(page.locator('#tax-profile-status')).toHaveText('Profilo salvato');
        expect(await firestore(page).get(`${SHARED}/tax_profile/default`)).toMatchObject({ previousYearRevenue: 30000 });
    });
});

test.describe('contenuti del sito', () => {
    test('una news pubblicata compare sul sito pubblico dopo il logout', async ({ page }) => {
        await loginViaUi(page);
        await openAdmin(page, { title: 'Gestisci News', mobileLabel: 'News e offerte' });
        await page.locator('#new-news-title').fill('Nuova sede a Monza');
        await page.locator('#new-news-content').fill('Da ottobre ricevo anche a Monza.');
        await page.getByRole('button', { name: 'Pubblica News' }).click();
        await expect(page.locator('#news-management-list')).toContainText('Nuova sede a Monza');
        const published = (await firestore(page).list(`${PUBLIC}/news_list`)).find(n => n.title === 'Nuova sede a Monza');
        expect(published).toBeTruthy();
        await page.evaluate(() => window.handleLogout());
        await expect(page.locator('#public-news-grid')).toContainText('Nuova sede a Monza');
    });
});

test.describe('backup e ripristino', () => {
    test('esporta un backup completo e lo reimporta', async ({ page }, testInfo) => {
        await loginViaUi(page);
        await openAdmin(page, { title: 'Backup & Ripristino', mobileLabel: 'Backup e ripristino' });
        await expect(page.locator('#backup-modal')).toBeVisible();
        const [download] = await Promise.all([
            page.waitForEvent('download'),
            page.locator('#backup-modal').getByRole('button', { name: /Esporta/ }).click()
        ]);
        expect(download.suggestedFilename()).toMatch(/^backup_silvia_.*\.json$/);
        const file = testInfo.outputPath('backup.json');
        await download.saveAs(file);
        const payload = JSON.parse(await readFile(file, 'utf8'));
        expect(payload.schema).toBe('silvia-chinellato-backup');
        expect(payload.data.patients).toHaveLength(3);

        payload.data.patients.push(patient({ id: 'p_restored', name: 'Paziente Ripristinato' }));
        await page.locator('#backup-file-input').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(payload)) });
        await expect(page.locator('#backup-analysis')).toContainText('Backup valido');
        await expect(page.locator('#backup-restore-btn')).toBeEnabled();
        await page.locator('#backup-restore-btn').click();
        await page.getByRole('button', { name: 'Sì, ripristina' }).click();
        await expect(page.locator('#backup-progress')).toHaveText('Ripristino completato con successo.');
        expect(await firestore(page).get(`${SHARED}/patients_list/p_restored`)).toMatchObject({ name: 'Paziente Ripristinato' });
    });

    test('rifiuta un file non valido', async ({ page }) => {
        await loginViaUi(page);
        await openAdmin(page, { title: 'Backup & Ripristino', mobileLabel: 'Backup e ripristino' });
        await page.locator('#backup-file-input').setInputFiles({ name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('{"schema":"altro"}') });
        await expect(page.locator('#backup-analysis')).toContainText('Backup non valido');
        await expect(page.locator('#backup-restore-btn')).toBeDisabled();
    });
});
