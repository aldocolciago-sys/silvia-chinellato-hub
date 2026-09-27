import { describe, it, expect, afterEach } from 'vitest';
import { bootApp, SHARED } from '../support/jsdom-app.js';
import { seedDocs, center, patient, studioEvent } from '../fixtures/seed.js';

let app;
afterEach(() => app?.close());

/** Data locale (senza fuso) spostata di `days` giorni rispetto ad oggi, alle 09:00. */
function relativeDay(days) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    d.setHours(9, 0, 0, 0);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T09:00:00`;
}

async function loggedIn(data = {}) {
    app = await bootApp({ docs: seedDocs({ centers: [center()], ...data }) });
    await app.login();
    app.window.closeSyncReportModal();
    return app;
}

function fillPatient(values) {
    const map = { name: 'patient-name', phone: 'patient-phone', email: 'patient-email', notes: 'patient-notes', currentIssues: 'patient-current-issues', goals: 'patient-goals', allergies: 'patient-allergies', medications: 'patient-medications', tags: 'patient-tags', recallDays: 'patient-recall-days' };
    for (const [key, value] of Object.entries(values)) app.setValue(map[key], value);
}

const cardNames = () => app.$$('#patients-alphabetical-list strong').map(s => s.textContent);

describe('anagrafica pazienti', () => {
    it('crea un nuovo paziente dall’anagrafica normalizzando i tag', async () => {
        await loggedIn();
        app.window.openPatientsModal();
        app.window.openNewPatientFromRegistry();
        expect(app.text('patient-edit-modal-title')).toBe('Nuovo Paziente');
        fillPatient({ name: '  Anna Verdi ', phone: '333 999', email: 'anna@example.com', tags: 'cervicale,  postura , ,', recallDays: '90', allergies: 'Nichel' });
        await app.submit('patient-form');
        const saved = app.mock.list(`${SHARED}/patients_list`);
        expect(saved).toHaveLength(1);
        expect(saved[0]).toMatchObject({ name: 'Anna Verdi', phone: '333 999', tags: ['cervicale', 'postura'], recallDays: 90, allergies: 'Nichel' });
        expect(saved[0].id).toMatch(/^pat_\d+$/);
        expect(app.isHidden('patient-edit-modal')).toBe(true);
        expect(app.toast()).toBe('Paziente salvato con successo!');
        expect(cardNames()).toEqual(['Anna Verdi']);
        expect([...app.byId('studio-patient-select').options].map(o => o.textContent)).toContain('Anna Verdi');
    });

    it('elenca i pazienti in ordine alfabetico e filtra per nome, telefono, email, tag e problemi', async () => {
        await loggedIn({
            patients: [
                patient({ id: 'p1', name: 'Zeno Bruni', phone: '111', tags: ['sportivo'] }),
                patient({ id: 'p2', name: 'Anna Verdi', email: 'anna@x.it', currentIssues: 'Cervicalgia' }),
                patient({ id: 'p3', name: 'Marco Neri', phone: '333 777' })
            ]
        });
        app.window.openPatientsModal();
        expect(cardNames()).toEqual(['Anna Verdi', 'Marco Neri', 'Zeno Bruni']);
        const search = (q) => { app.setValue('patient-search-input', q); app.window.filterPatientsList(); return cardNames(); };
        expect(search('SPORTIVO')).toEqual(['Zeno Bruni']);
        expect(search('333 777')).toEqual(['Marco Neri']);
        expect(search('anna@x')).toEqual(['Anna Verdi']);
        expect(search('cervicalgia')).toEqual(['Anna Verdi']);
        expect(search('nessuno')).toEqual([]);
        expect(app.text('patients-alphabetical-list')).toBe('Nessun paziente trovato.');
    });

    it('mostra lo stato operativo del paziente (Nuovo, Prenotato, Attivo, Da richiamare)', async () => {
        await loggedIn({
            patients: [
                patient({ id: 'nuovo', name: 'A Nuovo' }),
                patient({ id: 'pren', name: 'B Prenotato' }),
                patient({ id: 'att', name: 'C Attivo' }),
                patient({ id: 'rich', name: 'D Richiamo', recallDays: 30 })
            ],
            events: [
                studioEvent({ id: 'f', start: relativeDay(5), end: relativeDay(5), extendedProps: { patientId: 'pren' } }),
                studioEvent({ id: 'p', start: relativeDay(-10), end: relativeDay(-10), extendedProps: { patientId: 'att' } }),
                studioEvent({ id: 'r', start: relativeDay(-40), end: relativeDay(-40), extendedProps: { patientId: 'rich' } })
            ]
        });
        app.window.openPatientsModal();
        const badges = Object.fromEntries(app.$$('#patients-alphabetical-list > div').map(card => [card.querySelector('strong').textContent, card.querySelector('strong + span').textContent.trim()]));
        expect(badges).toEqual({ 'A Nuovo': 'Nuovo', 'B Prenotato': 'Prenotato', 'C Attivo': 'Attivo', 'D Richiamo': 'Da richiamare' });
    });

    it('espande la scheda mostrando ultima seduta clinica e dettagli', async () => {
        await loggedIn({
            patients: [patient({ id: 'p1', name: 'Mario Rossi', goals: 'Correre', notes: 'Note generali' })],
            events: [studioEvent({ id: 'v1', start: relativeDay(-3), end: relativeDay(-3), extendedProps: { patientId: 'p1' } })],
            clinicalSessions: [{ id: 'v1', eventId: 'v1', patientId: 'p1', start: relativeDay(-3), clinicalNote: 'Trattamento lombare', clinicalOutcome: 'Buono' }]
        });
        app.window.openPatientsModal();
        app.window.togglePatientCard('p1');
        const card = app.text('patients-alphabetical-list');
        expect(card).toContain('ULTIMA SEDUTA CLINICA');
        expect(card).toContain('Trattamento lombare');
        expect(card).toContain('Correre');
        expect(card).toContain('Note generali');
        app.window.togglePatientCard('p1');
        expect(app.text('patients-alphabetical-list')).not.toContain('Trattamento lombare');
    });

    it('modifica un paziente esistente mostrando l’archivio clinico', async () => {
        await loggedIn({
            patients: [patient({ id: 'p1', name: 'Mario Rossi', tags: ['a', 'b'] })],
            clinicalSessions: [
                { id: 's1', eventId: 's1', patientId: 'p1', start: '2030-01-10T09:00:00', title: 'Prima', clinicalNote: '<b>nota</b>' },
                { id: 's2', eventId: 's2', patientId: 'p1', start: '2030-02-10T09:00:00', title: 'Seconda', clinicalOutcome: 'ok' }
            ]
        });
        app.window.editPatientById('p1');
        expect(app.text('patient-edit-modal-title')).toBe('Modifica Paziente');
        expect(app.byId('patient-tags').value).toBe('a, b');
        expect(app.isHidden('patient-clinical-archive-panel')).toBe(false);
        expect(app.text('patient-clinical-archive-summary')).toBe('2 sedute • ultima 10/02/2030');
        const titles = app.$$('#patient-clinical-archive-list article strong').map(s => s.textContent);
        expect(titles).toEqual(['Seconda', 'Prima']);
        expect(app.$('#patient-clinical-archive-list b b')).toBeNull(); // HTML della nota sottoposto a escape
        fillPatient({ phone: '000' });
        await app.submit('patient-form');
        expect(app.mock.get(`${SHARED}/patients_list/p1`)).toMatchObject({ name: 'Mario Rossi', phone: '000' });
    });

    it('segnala un paziente non trovato', async () => {
        await loggedIn();
        app.window.editPatientById('fantasma');
        expect(app.toast()).toBe('Paziente non trovato. Aggiorna la pagina e riprova.');
    });

    it('mostra un errore se il salvataggio del paziente fallisce', async () => {
        await loggedIn();
        app.window.openNewPatientFromRegistry();
        fillPatient({ name: 'Errore' });
        app.mock.failNext('setDoc', `${SHARED}/patients_list`);
        await app.submit('patient-form');
        expect(app.toast()).toBe('Errore: il paziente non è stato salvato. Controlla i permessi Firestore.');
        expect(app.state.patients).toHaveLength(0);
        expect(app.isHidden('patient-edit-modal')).toBe(false);
    });

    it('elimina un paziente scollegando gli appuntamenti e cancellando le sedute', async () => {
        await loggedIn({
            patients: [patient({ id: 'p1' })],
            events: [studioEvent({ id: 'e1', extendedProps: { patientId: 'p1' } })],
            clinicalSessions: [{ id: 'e1', eventId: 'e1', patientId: 'p1', clinicalNote: 'x' }]
        });
        app.window.confirmDeletePatient('p1');
        await app.confirm();
        expect(app.mock.has(`${SHARED}/patients_list/p1`)).toBe(false);
        expect(app.mock.has(`${SHARED}/clinical_sessions/e1`)).toBe(false);
        expect(app.mock.get(`${SHARED}/studio_events/e1`).extendedProps.patientId).toBeNull();
        expect(app.state.patients).toHaveLength(0);
        expect(app.toast()).toBe('Paziente eliminato definitivamente.');
    });

    it('segnala l’errore se l’eliminazione del paziente fallisce', async () => {
        await loggedIn({ patients: [patient({ id: 'p1' })] });
        app.mock.failNext('deleteDoc', `${SHARED}/patients_list/p1`);
        app.window.confirmDeletePatient('p1');
        await app.confirm();
        expect(app.toast()).toBe('Errore: eliminazione non completata. Controlla i permessi Firestore.');
        expect(app.state.patients).toHaveLength(1);
    });

    it('mostra lo storico appuntamenti del paziente e apre un evento', async () => {
        await loggedIn({
            patients: [patient({ id: 'p1', name: 'Mario Rossi' })],
            events: [
                studioEvent({ id: 'old', title: 'Vecchia visita', start: relativeDay(-400), end: relativeDay(-400), extendedProps: { patientId: 'p1', fee: 50, paymentStatus: 'unpaid' } }),
                studioEvent({ id: 'new', title: 'Nuova visita', start: relativeDay(10), end: relativeDay(10), extendedProps: { patientId: 'p1' } }),
                studioEvent({ id: 'nc', title: 'Privato', extendedProps: { patientId: 'p1', isNonClinical: true } })
            ]
        });
        app.window.openPatientHistoryModal('p1');
        expect(app.text('patient-history-title')).toBe('Storico: Mario Rossi');
        const items = app.$$('#patient-history-list > button');
        expect(items.map(b => b.querySelector('strong').textContent)).toEqual(['Nuova visita', 'Vecchia visita']);
        expect(items[0].textContent).toContain('Futuro');
        expect(items[1].textContent).toContain('Passato');
        expect(items[1].textContent).toContain('€ 50.00 • Da incassare');
        app.window.openEventFromHistory(encodeURIComponent('old'));
        expect(app.isHidden('patient-history-modal')).toBe(true);
        expect(app.isHidden('studio-modal')).toBe(false);
        expect(app.byId('studio-edit-event-id').value).toBe('old');
    });
});

describe('pazienti dal modulo appuntamento', () => {
    it('crea un paziente dall’appuntamento e lo associa automaticamente', async () => {
        await loggedIn();
        app.window.openStudioModal();
        app.window.openNewPatientFromAppointment('Laura Blu');
        expect(app.byId('patient-name').value).toBe('Laura Blu');
        await app.submit('patient-form');
        const created = app.state.patients[0];
        expect(app.byId('studio-patient-select').value).toBe(created.id);
        expect(app.byId('studio-title').value).toBe('Visita / Trattamento - Laura Blu');
        expect(app.toast()).toBe('Paziente creato e associato. Ora salva l’appuntamento.');
        expect(app.isHidden('studio-modal')).toBe(false);
        app.setValue('studio-date', '2030-05-05');
        await app.submit('studio-event-form');
        expect(app.mock.list(`${SHARED}/studio_events`)[0].extendedProps.patientId).toBe(created.id);
    });

    it('modifica il paziente selezionato senza uscire dall’appuntamento', async () => {
        await loggedIn({ patients: [patient({ id: 'p1', name: 'Mario Rossi' })] });
        app.window.openStudioModal();
        app.setValue('studio-patient-select', 'p1');
        app.window.editSelectedPatientFromAppointment();
        fillPatient({ allergies: 'Polline' });
        await app.submit('patient-form');
        expect(app.toast()).toBe('Scheda paziente aggiornata.');
        expect(app.text('live-patient-summary')).toContain('Polline');
    });

    it('crea un paziente dal titolo di un evento importato togliendo il prefisso automatico', async () => {
        await loggedIn();
        app.window.openStudioModal();
        app.setValue('studio-title', 'Visita / Trattamento - Carla Gialli');
        app.window.createPatientFromImportedEvent();
        expect(app.byId('patient-name').value).toBe('Carla Gialli');
    });
});

describe('unione pazienti duplicati', () => {
    const duplicates = [
        patient({ id: 'keep', name: 'Mario Rossi', phone: '333 111', email: '', notes: 'Nota A', tags: ['a'] }),
        patient({ id: 'dup', name: 'Mario Rosi', phone: '333111', email: 'mario@x.it', notes: 'Nota B', tags: ['a', 'b'] }),
        patient({ id: 'other', name: 'Giulia Bianchi', phone: '999' })
    ];

    it('suggerisce le coppie probabili e mostra il confronto dei campi', async () => {
        await loggedIn({ patients: duplicates, events: [studioEvent({ id: 'e1', title: 'Visita / Trattamento - Mario Rosi', extendedProps: { patientId: 'dup' } })] });
        app.window.openMergePatientsModal();
        const suggestion = app.$('#merge-suggestions button');
        expect(suggestion.textContent).toContain('Mario Rossi');
        expect(suggestion.textContent).toContain('Mario Rosi');
        expect(app.$$('#merge-suggestions button').length).toBe(1);
        app.window.selectMergePair('keep', 'dup');
        expect(app.$('input[name="merge-notes"][value="combine"]')).not.toBeNull();
        expect(app.$('input[name="merge-phone"][value="combine"]')).toBeNull();
        expect(app.text('merge-summary')).toContain('1 appuntamenti saranno riassegnati');
    });

    it('unisce i pazienti rispettando le scelte e riassegnando appuntamenti e sedute', async () => {
        await loggedIn({
            patients: duplicates,
            events: [studioEvent({ id: 'e1', title: 'Visita / Trattamento - Mario Rosi', extendedProps: { patientId: 'dup' } })],
            clinicalSessions: [{ id: 'e1', eventId: 'e1', patientId: 'dup', clinicalNote: 'x' }]
        });
        app.window.openMergePatientsModal();
        app.window.selectMergePair('keep', 'dup');
        app.$('input[name="merge-notes"][value="combine"]').checked = true;
        app.$('input[name="merge-email"][value="remove"]').checked = true;
        await app.window.mergeSelectedPatients();
        await app.flush();
        const kept = app.mock.get(`${SHARED}/patients_list/keep`);
        expect(kept.notes).toBe('Nota A\n\nNota B');
        expect(kept.email).toBe('mario@x.it');
        expect(kept.tags).toEqual(['a', 'b']);
        expect(app.mock.has(`${SHARED}/patients_list/dup`)).toBe(false);
        const ev = app.mock.get(`${SHARED}/studio_events/e1`);
        expect(ev.extendedProps.patientId).toBe('keep');
        expect(ev.title).toBe('Visita / Trattamento - Mario Rossi');
        expect(app.mock.get(`${SHARED}/clinical_sessions/e1`).patientId).toBe('keep');
        expect(app.toast()).toBe('Pazienti uniti con successo.');
    });

    it('rifiuta l’unione di un paziente con sé stesso', async () => {
        await loggedIn({ patients: duplicates });
        app.window.openMergePatientsModal();
        app.window.selectMergePair('keep', 'keep');
        await app.window.mergeSelectedPatients();
        expect(app.toast()).toBe('Seleziona due pazienti diversi.');
    });

    it('non elimina il duplicato se una scrittura fallisce', async () => {
        await loggedIn({ patients: duplicates });
        app.window.openMergePatientsModal();
        app.window.selectMergePair('keep', 'dup');
        app.mock.failNext('setDoc', `${SHARED}/patients_list/keep`);
        await app.window.mergeSelectedPatients();
        await app.flush();
        expect(app.mock.has(`${SHARED}/patients_list/dup`)).toBe(true);
        expect(app.toast()).toBe('Errore durante l’unione: nessuna scheda è stata rimossa localmente.');
    });
});

describe('richiami e appuntamenti senza paziente', () => {
    it('elenca i pazienti da richiamare oltre la soglia, escludendo chi ha un appuntamento futuro', async () => {
        await loggedIn({
            patients: [
                patient({ id: 'old', name: 'Vecchio Paziente', phone: '+39 333 000', email: 'v@x.it' }),
                patient({ id: 'recent', name: 'Recente' }),
                patient({ id: 'booked', name: 'Prenotato' }),
                patient({ id: 'never', name: 'Mai Visto', phone: '', email: '' })
            ],
            events: [
                studioEvent({ id: 'a', start: relativeDay(-200), end: relativeDay(-200), extendedProps: { patientId: 'old' } }),
                studioEvent({ id: 'b', start: relativeDay(-70), end: relativeDay(-70), extendedProps: { patientId: 'recent' } }),
                studioEvent({ id: 'c', start: relativeDay(-300), end: relativeDay(-300), extendedProps: { patientId: 'booked' } }),
                studioEvent({ id: 'd', start: relativeDay(7), end: relativeDay(7), extendedProps: { patientId: 'booked' } })
            ]
        });
        app.window.openRecallModal();
        const names = app.$$('#recall-list strong.font-editorial').map(s => s.textContent);
        expect(names).toEqual(['Mai Visto', 'Vecchio Paziente']);
        expect(app.text('recall-list')).toContain('1 pazienti esclusi');
        const wa = app.$('#recall-list a[href^="https://wa.me/"]');
        expect(wa.getAttribute('href')).toMatch(/^https:\/\/wa\.me\/39333000\?text=/);
        expect(wa.getAttribute('rel')).toBe('noopener noreferrer');
        expect(app.text('recall-list')).toContain('WhatsApp non disponibile');
        app.setValue('recall-threshold', '60');
        app.window.renderRecallList();
        expect(app.$$('#recall-list strong.font-editorial').map(s => s.textContent)).toEqual(['Mai Visto', 'Vecchio Paziente', 'Recente']);
    });

    it('elenca gli appuntamenti senza paziente con suggerimenti e filtro passati/futuri', async () => {
        await loggedIn({
            patients: [patient({ id: 'p1', name: 'Mario Rossi' })],
            events: [
                studioEvent({ id: 'past', title: 'Rossi Mario', start: relativeDay(-2), end: relativeDay(-2) }),
                studioEvent({ id: 'future', title: 'Sconosciuto', start: relativeDay(2), end: relativeDay(2) }),
                studioEvent({ id: 'assigned', start: relativeDay(3), end: relativeDay(3), extendedProps: { patientId: 'p1' } }),
                studioEvent({ id: 'nc', start: relativeDay(4), end: relativeDay(4), extendedProps: { isNonClinical: true } })
            ]
        });
        app.window.openUnassignedEventsModal();
        expect(app.text('unassigned-events-summary')).toBe('2 appuntamenti senza paziente • 1 passati • 1 futuri');
        const list = app.$$('#unassigned-events-list > button');
        expect(list).toHaveLength(2);
        expect(list[0].textContent).toContain('Mario Rossi 100%');
        expect(list[1].textContent).toContain('Nessuna corrispondenza suggerita.');
        app.setValue('unassigned-events-filter', 'future');
        app.window.renderUnassignedEventsList();
        expect(app.$$('#unassigned-events-list > button').length).toBe(1);
        app.window.openUnassignedEvent(encodeURIComponent('future'));
        expect(app.isHidden('unassigned-events-modal')).toBe(true);
        expect(app.byId('studio-edit-event-id').value).toBe('future');
        expect(app.isHidden('patient-match-suggestions')).toBe(false);
    });
});
