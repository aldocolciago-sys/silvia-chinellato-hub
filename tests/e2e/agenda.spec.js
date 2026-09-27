import { test, expect, loginViaUi, isMobile, firestore, localDate } from './fixtures.js';
import { seedDocs, center, patient, studioEvent, SHARED } from '../fixtures/seed.js';

const today = localDate(0);

async function openNewAppointment(page) {
    if (isMobile(page)) await page.locator('#mobile-admin-nav').getByRole('button', { name: 'Appuntamento' }).click();
    else await page.getByRole('button', { name: 'Studio', exact: true }).click();
    await expect(page.locator('#studio-modal')).toBeVisible();
}

test.describe('agenda', () => {
    test.use({
        firebaseSeed: {
            popupUser: { email: 'silviachine@gmail.com', uid: 'uid-silviachine@gmail.com' },
            docs: seedDocs({
                centers: [center({ id: 'c1', name: 'Centro Polisalute', color: '#4a8fa8' })],
                patients: [patient({ id: 'pat_1', name: 'Mario Rossi', phone: '333 1234567', allergies: 'Lattosio' })],
                events: [
                    studioEvent({ id: 'evt_seed', title: 'Controllo Giulia', start: `${today}T15:00:00`, end: `${today}T16:00:00` })
                ]
            })
        }
    });

    test('mostra gli appuntamenti esistenti nel calendario', async ({ page }) => {
        await loginViaUi(page);
        await expect(page.locator('#calendar')).toContainText('Controllo Giulia');
    });

    test('crea un appuntamento dal modulo e lo mostra in agenda', async ({ page }) => {
        await loginViaUi(page);
        await openNewAppointment(page);
        await page.locator('#studio-patient-select').selectOption('pat_1');
        await expect(page.locator('#studio-title')).toHaveValue('Visita / Trattamento - Mario Rossi');
        await expect(page.locator('#live-patient-summary')).toContainText('Allergie: Lattosio');
        await page.locator('#studio-center-select').selectOption('c1');
        await page.locator('#studio-date').fill(today);
        await page.locator('#studio-time-start').selectOption('10:00');
        await expect(page.locator('#studio-time-end')).toHaveValue('11:00');
        await page.locator('#studio-fee').fill('60');
        await page.locator('#studio-payment-status').selectOption('unpaid');
        await page.locator('#studio-clinical-note').fill('Lombalgia acuta');
        await page.getByRole('button', { name: 'Salva Appuntamento' }).click();

        await expect(page.locator('#studio-modal')).toBeHidden();
        await expect(page.locator('#toast-message')).toHaveText('Appuntamento salvato con successo!');
        await expect(page.locator('#calendar')).toContainText('Visita / Trattamento - Mario Rossi');
        const events = await firestore(page).list(`${SHARED}/studio_events`);
        const created = events.find(e => e.id !== 'evt_seed');
        expect(created).toMatchObject({ start: `${today}T10:00:00`, end: `${today}T11:00:00`, extendedProps: { patientId: 'pat_1', centerId: 'c1', fee: 60, paymentStatus: 'unpaid' } });
        expect(await firestore(page).get(`${SHARED}/clinical_sessions/${created.id}`)).toMatchObject({ clinicalNote: 'Lombalgia acuta' });
    });

    test('apre, modifica ed elimina un appuntamento cliccandolo nel calendario', async ({ page }) => {
        await loginViaUi(page);
        await page.locator('#calendar').getByText('Controllo Giulia').click();
        await expect(page.locator('#studio-modal')).toBeVisible();
        await expect(page.locator('#studio-modal-title')).toHaveText('Modifica / Gestisci Appuntamento');
        await expect(page.locator('#studio-time-start')).toHaveValue('15:00');
        await page.locator('#studio-title').fill('Controllo Giulia (spostato)');
        await page.getByRole('button', { name: 'Salva Appuntamento' }).click();
        await expect(page.locator('#calendar')).toContainText('Controllo Giulia (spostato)');

        await page.locator('#calendar').getByText('Controllo Giulia (spostato)').click();
        await page.locator('#studio-delete-btn').click();
        await expect(page.locator('#confirm-modal')).toBeVisible();
        await page.locator('#confirm-ok-btn').click();
        await expect(page.locator('#confirm-modal')).toBeHidden();
        await expect(page.locator('#calendar')).not.toContainText('Controllo Giulia');
        expect(await firestore(page).has(`${SHARED}/studio_events/evt_seed`)).toBe(false);
    });

    test('segnala le sovrapposizioni e porta al conflitto', async ({ page }) => {
        await loginViaUi(page);
        await openNewAppointment(page);
        await page.locator('#studio-title').fill('Sovrapposto');
        await page.locator('#studio-date').fill(today);
        await page.locator('#studio-time-start').selectOption('15:30');
        await page.getByRole('button', { name: 'Salva Appuntamento' }).click();
        await expect(page.locator('#calendar-conflict-banner')).toBeVisible();
        await expect(page.locator('#conflict-banner-text')).toHaveText('Attenzione: Rilevate 1 sovrapposizioni orarie in agenda!');
        await page.locator('#calendar-conflict-banner button').click();
        await expect(page.locator('#calendar')).toContainText('[CONFLITTO]');
    });

    test('un errore di salvataggio viene mostrato e il modulo resta aperto', async ({ page }) => {
        await loginViaUi(page);
        await openNewAppointment(page);
        await page.locator('#studio-title').fill('Non salvato');
        await firestore(page).failNext('setDoc', `${SHARED}/studio_events`);
        await page.getByRole('button', { name: 'Salva Appuntamento' }).click();
        await expect(page.locator('#toast-message')).toHaveText('Errore: salvataggio non completato.');
        await expect(page.locator('#studio-modal')).toBeVisible();
    });

    test('il titolo è obbligatorio', async ({ page }) => {
        await loginViaUi(page);
        await openNewAppointment(page);
        await page.locator('#studio-title').fill('');
        await page.getByRole('button', { name: 'Salva Appuntamento' }).click();
        await expect(page.locator('#studio-modal')).toBeVisible();
        const valid = await page.locator('#studio-title').evaluate(el => el.checkValidity());
        expect(valid).toBe(false);
    });

    test('cambia vista del calendario su desktop', async ({ page }) => {
        test.skip(isMobile(page), 'Su mobile la vista è fissa su agenda settimanale');
        await loginViaUi(page);
        await page.locator('#calendar').getByRole('button', { name: 'Settimana', exact: true }).click();
        await expect(page.locator('.fc-timeGridWeek-view')).toBeVisible();
        await page.getByRole('button', { name: 'Giorno' }).click();
        await expect(page.locator('.fc-timeGridDay-view')).toBeVisible();
        await page.getByRole('button', { name: 'Mese' }).click();
        await expect(page.locator('.fc-dayGridMonth-view')).toBeVisible();
    });
});
