/**
 * Verifica completa dei controlli dell'area riservata, in modalità desktop e mobile:
 *  - ogni funzione è raggiungibile (header su desktop, barra inferiore + menu "Altro" su mobile);
 *  - in ogni finestra tutti i pulsanti e campi visibili stanno nello schermo e sono cliccabili
 *    (non coperti da altri elementi, es. barra inferiore o toast);
 *  - ogni tipo di elemento (paziente, news, trattamento, sede, guida, entrata, appuntamento)
 *    ha il pulsante "Elimina" e l'eliminazione funziona davvero (anche su Firestore).
 */
import { test, expect, loginViaUi, isMobile, firestore, localDate } from './fixtures.js';
import { seedDocs, center, patient, studioEvent, SHARED, PUBLIC } from '../fixtures/seed.js';

const today = localDate(0);

test.use({
    firebaseSeed: {
        popupUser: { email: 'silviachine@gmail.com', uid: 'uid-silviachine@gmail.com' },
        docs: seedDocs({
            centers: [center({ id: 'c1', name: 'Centro Polisalute' }), center({ id: 'c2', name: 'Sede da eliminare' })],
            patients: [patient({ id: 'p1', name: 'Mario Rossi' }), patient({ id: 'p2', name: 'Paziente da eliminare', phone: '333 000' })],
            events: [
                studioEvent({ id: 'e1', title: 'Visita di oggi', start: `${today}T10:00:00`, end: `${today}T11:00:00`, extendedProps: { patientId: 'p1', fee: 50 } }),
                studioEvent({ id: 'e2', title: 'Senza paziente', start: `${today}T15:00:00`, end: `${today}T16:00:00` })
            ],
            manualRevenues: [{ id: 'r1', date: today, amount: 300, category: 'Fatturato storico', description: 'Entrata da eliminare' }],
            treatments: [{ id: 't1', title: 'Trattamento da eliminare', icon: 'fa-spa', desc: 'Descrizione' }],
            news: [{ id: 'n1', title: 'News da eliminare', date: today, content: 'Testo', link: '' }],
            preparations: [{ id: 'g1', title: 'Guida da eliminare', tag: 'Osteopatia', content: 'Contenuto' }]
        })
    }
});

/** Come si apre ogni funzione: pulsante nell'header (desktop) o nella navigazione mobile. */
const ENTRY_POINTS = [
    { name: 'Nuovo appuntamento', modal: 'studio-modal', desktop: { role: 'Studio' }, mobile: { nav: 'Appuntamento' } },
    { name: 'Pazienti', modal: 'patients-modal', desktop: { title: 'Pazienti' }, mobile: { nav: 'Pazienti' } },
    { name: 'Poliambulatori', modal: 'centers-modal', desktop: { title: 'Gestisci Poliambulatori' }, mobile: { more: 'Poliambulatori' } },
    { name: 'Trattamenti', modal: 'treatments-admin-modal', desktop: { title: 'Gestisci Trattamenti' }, mobile: { more: 'Trattamenti' } },
    { name: 'News', modal: 'news-admin-modal', desktop: { title: 'Gestisci News' }, mobile: { more: 'News e offerte' } },
    { name: 'Guide di preparazione', modal: 'prep-admin-modal', desktop: { title: 'Gestisci Preparazione' }, mobile: { more: 'Preparazione' } },
    { name: 'Compensi', modal: 'business-dashboard-modal', desktop: { title: 'Dashboard compensi' }, mobile: { more: 'Compensi' } },
    { name: 'Richiami', modal: 'recall-modal', desktop: { title: 'Pazienti da richiamare' }, mobile: { more: 'Richiami' } },
    { name: 'Appuntamenti senza paziente', modal: 'unassigned-events-modal', desktop: { title: 'Appuntamenti senza paziente' }, mobile: { more: 'Senza paziente' } },
    { name: 'Backup', modal: 'backup-modal', desktop: { title: 'Backup & Ripristino' }, mobile: { more: 'Backup e ripristino' } },
    { name: 'Ultime novità', modal: 'sync-report-modal', desktop: { role: 'Ultime novità' }, mobile: { more: 'Ultime novità' } },
    { name: 'Sincronizza calendari', modal: 'sync-report-modal', desktop: { role: 'Sincronizza Calendari' }, mobile: { nav: 'Sincronizza' } },
    { name: 'Settimana tipo', modal: 'agenda-settings-modal', desktop: { title: 'Settimana tipo e spostamenti' }, mobile: { more: 'Settimana tipo' } },
    { name: 'Promemoria di domani', modal: 'reminders-modal', desktop: { title: 'Promemoria di domani' }, mobile: { more: 'Promemoria' } }
];

async function openEntry(page, entry) {
    if (isMobile(page)) {
        if (entry.mobile.nav) {
            await page.locator('#mobile-admin-nav').getByRole('button', { name: entry.mobile.nav, exact: true }).click();
        } else {
            await page.locator('#mobile-admin-nav').getByRole('button', { name: 'Altro' }).click();
            await page.locator('#mobile-admin-more').getByRole('button', { name: entry.mobile.more, exact: true }).click();
        }
    } else if (entry.desktop.title) {
        await page.locator('#private-view > header').getByTitle(entry.desktop.title, { exact: true }).click();
    } else {
        await page.locator('#private-view > header').getByRole('button', { name: entry.desktop.role, exact: true }).click();
    }
    await expect(page.locator(`#${entry.modal}`)).toBeVisible();
}

async function closeModal(page, modalId) {
    const modal = page.locator(`#${modalId}`);
    if (modalId === 'sync-report-modal') await modal.getByRole('button', { name: 'Ho capito' }).click();
    else await modal.getByRole('button', { name: 'Chiudi' }).first().click();
    await expect(modal).toBeHidden();
}

/**
 * Controlla che ogni pulsante/campo visibile della finestra sia dentro lo schermo
 * e realmente cliccabile (click "di prova": verifica che nessun altro elemento lo copra).
 */
async function auditModal(page, modalId) {
    const modal = page.locator(`#${modalId}`);
    const controls = modal.locator('button, a[href], input:not([type="hidden"]), select, textarea');
    const viewport = page.viewportSize();
    const problems = [];
    const count = await controls.count();
    let checked = 0;
    for (let i = 0; i < count; i++) {
        const control = controls.nth(i);
        if (!(await control.isVisible())) continue;
        const label = await control.evaluate(el => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} "${(el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 40)}"`);
        if (await control.isDisabled()) continue;
        try {
            await control.scrollIntoViewIfNeeded({ timeout: 2000 });
            const box = await control.boundingBox();
            if (!box || box.width < 1 || box.height < 1) { problems.push(`${label}: dimensione nulla`); continue; }
            if (box.x < -1 || box.x + box.width > viewport.width + 1) problems.push(`${label}: fuori dallo schermo in orizzontale`);
            await control.click({ trial: true, timeout: 2000 });
            checked++;
        } catch (err) {
            problems.push(`${label}: non cliccabile (${err.message.split('\n')[0]})`);
        }
    }
    expect(problems, `Controlli con problemi in #${modalId}`).toEqual([]);
    expect(checked, `Nessun controllo verificato in #${modalId}`).toBeGreaterThan(0);
}

test.describe('raggiungibilità di tutte le funzioni', () => {
    for (const entry of ENTRY_POINTS) {
        test(`${entry.name}: si apre dal menu e tutti i controlli sono visibili e cliccabili`, async ({ page }) => {
            await loginViaUi(page);
            await openEntry(page, entry);
            await auditModal(page, entry.modal);
            await closeModal(page, entry.modal);
            if (isMobile(page)) await expect(page.locator('#mobile-admin-nav')).toBeVisible();
        });
    }

    test('schede secondarie: modifica paziente, storico, unione duplicati', async ({ page }) => {
        await loginViaUi(page);
        await openEntry(page, ENTRY_POINTS[1]);
        await page.locator('#patients-modal').getByRole('button', { name: /Nuovo Paziente/ }).click();
        await auditModal(page, 'patient-edit-modal');
        await closeModal(page, 'patient-edit-modal');
        const card = page.locator('#patients-alphabetical-list > div').filter({ hasText: 'Mario Rossi' });
        await card.getByRole('button', { name: /^Mario Rossi/ }).click();
        await card.getByRole('button', { name: 'Storico' }).filter({ visible: true }).first().click();
        await auditModal(page, 'patient-history-modal');
        await closeModal(page, 'patient-history-modal');
        await page.locator('#patients-modal').getByRole('button', { name: /Unisci duplicati/ }).click();
        await auditModal(page, 'merge-patients-modal');
    });

    test('appuntamento esistente: tutti i controlli di modifica, incluso Elimina', async ({ page }) => {
        await loginViaUi(page);
        await page.locator('#calendar').getByText('Visita di oggi').click();
        await expect(page.locator('#studio-delete-btn')).toBeVisible();
        await auditModal(page, 'studio-modal');
    });

    test('header desktop: tutti i pulsanti sono visibili', async ({ page }) => {
        test.skip(isMobile(page), 'Su mobile le funzioni sono nella barra inferiore');
        await loginViaUi(page);
        const header = page.locator('#private-view > header');
        for (const title of ['Gestisci Poliambulatori', 'Settimana tipo e spostamenti', 'Gestisci Trattamenti', 'Pazienti', 'Gestisci News', 'Gestisci Preparazione', 'Dashboard compensi', 'Promemoria di domani', 'Pazienti da richiamare', 'Appuntamenti senza paziente', 'Backup & Ripristino', 'Esci']) {
            await expect(header.getByTitle(title, { exact: true }), title).toBeVisible();
        }
        for (const name of ['Studio', 'Ultime novità', 'Sincronizza Calendari']) {
            await expect(header.getByRole('button', { name, exact: true }), name).toBeVisible();
        }
    });

    test('mobile: barra inferiore e menu "Altro" completi e cliccabili', async ({ page }) => {
        test.skip(!isMobile(page), 'Solo mobile');
        await loginViaUi(page);
        const nav = page.locator('#mobile-admin-nav');
        for (const button of await nav.getByRole('button').all()) await button.click({ trial: true });
        await nav.getByRole('button', { name: 'Altro' }).click();
        const more = page.locator('#mobile-admin-more');
        await expect(more.getByRole('button')).toHaveText(['Chiudi', 'Poliambulatori', 'Settimana tipo', 'Trattamenti', 'News e offerte', 'Preparazione', 'Compensi', 'Promemoria', 'Richiami', 'Ultime novità', 'Senza paziente', 'Backup e ripristino', 'Esci'].map(t => t === 'Chiudi' ? '' : t));
        for (const button of await more.getByRole('button').all()) await button.click({ trial: true });
    });
});

test.describe('pulsanti Elimina', () => {
    async function confirmDeletion(page) {
        await expect(page.locator('#confirm-modal')).toBeVisible();
        await page.locator('#confirm-ok-btn').click();
        await expect(page.locator('#confirm-modal')).toBeHidden();
    }

    test('paziente', async ({ page }) => {
        await loginViaUi(page);
        await openEntry(page, ENTRY_POINTS[1]);
        const card = page.locator('#patients-alphabetical-list > div').filter({ hasText: 'Paziente da eliminare' });
        await card.getByRole('button', { name: /^Paziente da eliminare/ }).click();
        await card.getByRole('button', { name: 'Elimina', exact: true }).click();
        await confirmDeletion(page);
        await expect(page.locator('#toast-message')).toHaveText('Paziente eliminato definitivamente.');
        await expect(page.locator('#patients-alphabetical-list')).not.toContainText('Paziente da eliminare');
        expect(await firestore(page).has(`${SHARED}/patients_list/p2`)).toBe(false);
    });

    for (const item of [
        { name: 'news', entry: 4, list: '#news-management-list', text: 'News da eliminare', path: `${PUBLIC}/news_list/n1`, toast: 'News eliminata.', publicGrid: '#public-news-grid' },
        { name: 'trattamento', entry: 3, list: '#treatments-management-list', text: 'Trattamento da eliminare', path: `${PUBLIC}/treatments_list/t1`, toast: 'Trattamento eliminato.', publicGrid: '#public-treatments-grid' },
        { name: 'poliambulatorio', entry: 2, list: '#centers-management-list', text: 'Sede da eliminare', path: `${PUBLIC}/centers_list/c2`, toast: 'Poliambulatorio eliminato.', publicGrid: '#public-centers-grid' },
        { name: 'guida di preparazione', entry: 5, list: '#prep-management-list', text: 'Guida da eliminare', path: `${PUBLIC}/preparations_list/g1`, toast: 'Guida eliminata.', publicGrid: '#public-preparations-grid' }
    ]) {
        test(item.name, async ({ page }) => {
            await loginViaUi(page);
            await openEntry(page, ENTRY_POINTS[item.entry]);
            const row = page.locator(`${item.list} > div`).filter({ hasText: item.text });
            await expect(row.getByRole('button', { name: 'Elimina', exact: true })).toBeVisible();
            await row.getByRole('button', { name: 'Elimina', exact: true }).click();
            await confirmDeletion(page);
            await expect(page.locator('#toast-message')).toHaveText(item.toast);
            await expect(page.locator(item.list)).not.toContainText(item.text);
            expect(await firestore(page).has(item.path)).toBe(false);
            // anche il sito pubblico non mostra più l'elemento
            await expect(page.locator(item.publicGrid)).not.toContainText(item.text);
        });
    }

    test('entrata manuale', async ({ page }) => {
        await loginViaUi(page);
        await openEntry(page, ENTRY_POINTS[6]);
        const row = page.locator('#manual-revenue-list article').filter({ hasText: 'Entrata da eliminare' });
        await row.getByRole('button', { name: 'Elimina', exact: true }).click();
        await confirmDeletion(page);
        await expect(page.locator('#toast-message')).toHaveText('Entrata manuale eliminata.');
        expect(await firestore(page).has(`${SHARED}/manual_revenue/r1`)).toBe(false);
    });

    test('appuntamento', async ({ page }) => {
        await loginViaUi(page);
        await page.locator('#calendar').getByText('Senza paziente').click();
        await page.locator('#studio-delete-btn').click();
        await confirmDeletion(page);
        await expect(page.locator('#calendar')).not.toContainText('Senza paziente');
        expect(await firestore(page).has(`${SHARED}/studio_events/e2`)).toBe(false);
    });

    test('annullando la conferma non viene eliminato nulla', async ({ page }) => {
        await loginViaUi(page);
        await openEntry(page, ENTRY_POINTS[4]);
        await page.locator('#news-management-list > div').filter({ hasText: 'News da eliminare' }).getByRole('button', { name: 'Elimina' }).click();
        await page.locator('#confirm-cancel-btn').click();
        await expect(page.locator('#news-management-list')).toContainText('News da eliminare');
        expect(await firestore(page).has(`${PUBLIC}/news_list/n1`)).toBe(true);
    });
});

test.describe('pulsanti Modifica', () => {
    test('guida di preparazione (prima mancava il pulsante)', async ({ page }) => {
        await loginViaUi(page);
        await openEntry(page, ENTRY_POINTS[5]);
        const row = page.locator('#prep-management-list > div').filter({ hasText: 'Guida da eliminare' });
        await row.getByRole('button', { name: 'Modifica' }).click();
        await expect(page.locator('#prep-title')).toHaveValue('Guida da eliminare');
        await expect(page.locator('#prep-submit-btn-text')).toHaveText('Aggiorna Guida');
        await page.locator('#prep-title').fill('Guida aggiornata');
        await page.getByRole('button', { name: 'Aggiorna Guida' }).click();
        await expect(page.locator('#prep-management-list')).toContainText('Guida aggiornata');
        await expect(page.locator('#prep-management-list > div')).toHaveCount(1);
        expect(await firestore(page).get(`${PUBLIC}/preparations_list/g1`)).toMatchObject({ title: 'Guida aggiornata' });
    });

    for (const item of [
        { name: 'news', entry: 4, list: '#news-management-list', text: 'News da eliminare', field: '#new-news-title' },
        { name: 'trattamento', entry: 3, list: '#treatments-management-list', text: 'Trattamento da eliminare', field: '#new-treatment-title' },
        { name: 'poliambulatorio', entry: 2, list: '#centers-management-list', text: 'Sede da eliminare', field: '#new-center-name' }
    ]) {
        test(`${item.name}: il pulsante Modifica carica i dati nel modulo`, async ({ page }) => {
            await loginViaUi(page);
            await openEntry(page, ENTRY_POINTS[item.entry]);
            await page.locator(`${item.list} > div`).filter({ hasText: item.text }).getByRole('button', { name: 'Modifica' }).click();
            await expect(page.locator(item.field)).toHaveValue(item.text);
        });
    }

    test('entrata manuale: il pulsante Modifica carica i dati nel modulo', async ({ page }) => {
        await loginViaUi(page);
        await openEntry(page, ENTRY_POINTS[6]);
        await page.locator('#manual-revenue-list article').filter({ hasText: 'Entrata da eliminare' }).getByRole('button', { name: 'Modifica' }).click();
        await expect(page.locator('#manual-revenue-amount')).toHaveValue('300');
    });
});
