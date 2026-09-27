import { describe, it, expect, afterEach } from 'vitest';
import { bootApp, SHARED } from '../support/jsdom-app.js';
import { seedDocs, center, patient, studioEvent } from '../fixtures/seed.js';

let app;
afterEach(() => app?.close());

const centers = [
    center({ id: 'c1', name: 'Centro Polisalute', color: '#4a8fa8' }),
    center({ id: 'c2', name: 'Agenda personale', color: '#999999', isNonClinicalCalendar: true, showPublic: false, includeInFinance: false })
];
const patients = [patient({ id: 'pat_1', name: 'Mario Rossi', phone: '333 1234567', email: 'mario@example.com', allergies: 'Lattosio', tags: ['cervicale'] })];

async function loggedIn(extra = {}) {
    app = await bootApp({ docs: seedDocs({ centers, patients, ...extra }) });
    await app.login();
    app.window.closeSyncReportModal();
    return app;
}

function fillAppointment({ date = '2030-01-15', start = '09:00', end, centerId = '', patientId, title, fee, status, method, note, outcome } = {}) {
    if (centerId !== undefined) app.setValue('studio-center-select', centerId);
    if (patientId !== undefined) { app.setValue('studio-patient-select', patientId); app.window.onPatientSelectChange(); }
    if (title !== undefined) app.setValue('studio-title', title);
    app.setValue('studio-date', date);
    app.setValue('studio-time-start', start);
    app.window.onStartTimeChange();
    if (end) app.setValue('studio-time-end', end);
    if (fee !== undefined) app.setValue('studio-fee', String(fee));
    if (status) app.setValue('studio-payment-status', status);
    if (method) app.setValue('studio-payment-method', method);
    if (note !== undefined) app.setValue('studio-clinical-note', note);
    if (outcome !== undefined) app.setValue('studio-clinical-outcome', outcome);
}

describe('agenda: creazione appuntamenti', () => {
    it('apre il modulo con valori predefiniti', async () => {
        await loggedIn();
        app.window.openStudioModal();
        expect(app.isHidden('studio-modal')).toBe(false);
        expect(app.text('studio-modal-title')).toBe('Nuovo Appuntamento Studio / Sede');
        expect(app.byId('studio-date').value).toBe(new Date().toISOString().split('T')[0]);
        expect(app.byId('studio-time-start').value).toBe('09:00');
        expect(app.byId('studio-time-end').value).toBe('10:00');
        expect(app.byId('studio-payment-status').value).toBe('paid');
        expect(app.isHidden('studio-delete-btn')).toBe(true);
        const centerOptions = [...app.byId('studio-center-select').options].map(o => o.textContent);
        expect(centerOptions).toEqual(['Studio Privato (Default)', 'Centro Polisalute']);
        const times = [...app.byId('studio-time-start').options].map(o => o.value).filter(Boolean);
        expect(times[0]).toBe('07:00');
        expect(times.at(-1)).toBe('23:00');
        expect(times).toHaveLength(33);
    });

    it('selezionando un paziente compila titolo, contatti e riepilogo clinico', async () => {
        await loggedIn();
        app.window.openStudioModal();
        fillAppointment({ patientId: 'pat_1' });
        expect(app.byId('studio-title').value).toBe('Visita / Trattamento - Mario Rossi');
        expect(app.isHidden('patient-contact-info-container')).toBe(false);
        expect(app.byId('studio-patient-phone').value).toBe('333 1234567');
        expect(app.text('live-patient-summary')).toContain('Allergie: Lattosio');
        expect(app.text('live-patient-summary')).toContain('Tag: cervicale');
        app.setValue('studio-patient-select', '');
        app.window.onPatientSelectChange();
        expect(app.isHidden('patient-contact-info-container')).toBe(true);
    });

    it('salva un appuntamento con paziente, compenso e nota clinica', async () => {
        await loggedIn();
        app.window.openStudioModal();
        fillAppointment({ centerId: 'c1', patientId: 'pat_1', fee: 60, status: 'unpaid', method: 'card', note: 'Lombalgia acuta', outcome: 'Migliorato' });
        await app.submit('studio-event-form');

        expect(app.isHidden('studio-modal')).toBe(true);
        expect(app.toast()).toBe('Appuntamento salvato con successo!');
        const saved = app.mock.list(`${SHARED}/studio_events`);
        expect(saved).toHaveLength(1);
        const ev = saved[0];
        expect(ev).toMatchObject({
            title: 'Visita / Trattamento - Mario Rossi',
            start: '2030-01-15T09:00:00', end: '2030-01-15T10:00:00',
            backgroundColor: '#4a8fa8',
            extendedProps: { centerId: 'c1', centerName: 'Centro Polisalute', patientId: 'pat_1', fee: 60, paymentStatus: 'unpaid', paymentMethod: 'card', clinicalNote: 'Lombalgia acuta', clinicalOutcome: 'Migliorato', isNonClinical: false }
        });
        expect(ev.id).toMatch(/^evt_\d+$/);
        expect(app.mock.get(`${SHARED}/clinical_sessions/${ev.id}`)).toMatchObject({ patientId: 'pat_1', clinicalNote: 'Lombalgia acuta', fee: 60 });
        expect(app.calendar.renderedEvents.map(e => e.id)).toContain(ev.id);
    });

    it('non crea una seduta clinica senza nota né esito', async () => {
        await loggedIn();
        app.window.openStudioModal();
        fillAppointment({ patientId: 'pat_1' });
        await app.submit('studio-event-form');
        expect(app.mock.list(`${SHARED}/clinical_sessions`)).toHaveLength(0);
    });

    it('in modifica, rimuovendo la nota elimina la seduta clinica archiviata', async () => {
        const ev = studioEvent({ id: 'evt_9', extendedProps: { patientId: 'pat_1', clinicalNote: 'nota' } });
        await loggedIn({ events: [ev], clinicalSessions: [{ id: 'evt_9', eventId: 'evt_9', patientId: 'pat_1', clinicalNote: 'nota' }] });
        app.window.openStudioModal(app.state.events[0]);
        expect(app.text('studio-modal-title')).toBe('Modifica / Gestisci Appuntamento');
        expect(app.byId('studio-clinical-note').value).toBe('nota');
        expect(app.byId('studio-patient-select').value).toBe('pat_1');
        expect(app.isHidden('studio-delete-btn')).toBe(false);
        app.setValue('studio-clinical-note', '');
        await app.submit('studio-event-form');
        expect(app.mock.has(`${SHARED}/clinical_sessions/evt_9`)).toBe(false);
        expect(app.mock.get(`${SHARED}/studio_events/evt_9`).extendedProps.clinicalNote).toBe('');
    });

    it('calcola automaticamente l’orario di fine (+1h) con i limiti di fine giornata', async () => {
        await loggedIn();
        app.window.openStudioModal();
        const endFor = (start) => { app.setValue('studio-time-start', start); app.window.onStartTimeChange(); return app.byId('studio-time-end').value; };
        expect(endFor('07:30')).toBe('08:30');
        expect(endFor('22:00')).toBe('23:00');
        expect(endFor('22:30')).toBe('22:30'); // 23:30 non è selezionabile: resta l'orario d'inizio
        expect(endFor('23:00')).toBe('23:00');
    });

    it('mostra un errore e lascia aperto il modulo se il salvataggio fallisce', async () => {
        await loggedIn();
        app.window.openStudioModal();
        fillAppointment({ title: 'Prova' });
        app.mock.failNext('setDoc', `${SHARED}/studio_events`);
        await app.submit('studio-event-form');
        expect(app.toast()).toBe('Errore: salvataggio non completato.');
        expect(app.isHidden('studio-modal')).toBe(false);
        expect(app.mock.list(`${SHARED}/studio_events`)).toHaveLength(0);
    });

    // KNOWN BUG: se Firestore rifiuta la scrittura lo stato locale viene comunque modificato,
    // quindi l'agenda mostra un appuntamento che non esiste sul database.
    it.fails('non modifica lo stato locale se il salvataggio fallisce', async () => {
        await loggedIn();
        app.window.openStudioModal();
        fillAppointment({ title: 'Prova' });
        app.mock.failNext('setDoc', `${SHARED}/studio_events`);
        await app.submit('studio-event-form');
        expect(app.state.events).toHaveLength(0);
    });

    // KNOWN BUG: nessuna validazione impedisce un orario di fine precedente all'inizio.
    it.fails('rifiuta un appuntamento che termina prima di iniziare', async () => {
        await loggedIn();
        app.window.openStudioModal();
        fillAppointment({ title: 'Invertito', start: '10:00', end: '09:00' });
        await app.submit('studio-event-form');
        expect(app.mock.list(`${SHARED}/studio_events`)).toHaveLength(0);
    });
});

describe('agenda: calendari non clinici ed eventi esterni', () => {
    it('un evento di calendario non clinico nasconde le sezioni cliniche e azzera i dati sanitari', async () => {
        const ev = studioEvent({ id: 'evt_nc', title: 'Dentista', extendedProps: { centerId: 'c2', centerName: 'Agenda personale', patientId: 'pat_1', fee: 50, clinicalNote: 'x' } });
        await loggedIn({ events: [ev] });
        app.window.openStudioModal(app.state.events[0]);
        expect(app.isHidden('non-clinical-event-banner')).toBe(false);
        expect(app.isHidden('studio-patient-section')).toBe(true);
        expect(app.isHidden('studio-finance-section')).toBe(true);
        expect(app.isHidden('studio-clinical-section')).toBe(true);
        expect(app.byId('studio-center-select').value).toBe('c2');
        expect(app.byId('studio-center-select').selectedOptions[0].textContent).toContain('(Calendario non Clinico)');
        await app.submit('studio-event-form');
        expect(app.mock.get(`${SHARED}/studio_events/evt_nc`).extendedProps).toMatchObject({ patientId: null, fee: 0, paymentStatus: 'cancelled', paymentMethod: null, clinicalNote: '', isNonClinical: true });
    });

    it('un evento importato da iCal ha data/ora/sede bloccate e aggiorna solo i dati gestionali', async () => {
        const ev = studioEvent({ id: 'ical_c1_abc', title: 'Mario Rossi', start: '2030-01-15T08:00:00.000Z', end: '2030-01-15T09:00:00.000Z', extendedProps: { centerId: 'c1', centerName: 'Centro Polisalute' } });
        await loggedIn({ events: [ev] });
        app.window.openStudioModal(app.state.events[0]);
        expect(app.text('studio-modal-title')).toBe('Appuntamento Poliambulatorio (Centro Polisalute)');
        for (const id of ['studio-title', 'studio-date', 'studio-time-start', 'studio-time-end', 'studio-center-select']) {
            expect(app.byId(id).disabled, id).toBe(true);
        }
        expect(app.byId('studio-event-is-external').value).toBe('true');
        expect(app.isHidden('patient-match-suggestions')).toBe(false);
        expect(app.text('patient-match-suggestions')).toContain('Mario Rossi');
        app.window.selectSuggestedPatient('pat_1');
        expect(app.byId('studio-title').value).toBe('Mario Rossi'); // il titolo esterno non viene sovrascritto
        app.setValue('studio-fee', '70');
        await app.submit('studio-event-form');
        const saved = app.mock.get(`${SHARED}/studio_events/ical_c1_abc`);
        expect(saved.title).toBe('Mario Rossi');
        expect(saved.start).toBe('2030-01-15T08:00:00.000Z');
        expect(saved.extendedProps).toMatchObject({ patientId: 'pat_1', fee: 70, centerId: 'c1' });
    });

    it('mostra il banner per un evento esterno mantenuto dopo la cancellazione alla fonte', async () => {
        const ev = studioEvent({ id: 'ical_c1_old', extendedProps: { centerId: 'c1', detachedFromExternal: true, externalRemovedAt: '2030-01-10T10:00:00.000Z' } });
        await loggedIn({ events: [ev] });
        app.window.openStudioModal(app.state.events[0]);
        expect(app.isHidden('external-detached-banner')).toBe(false);
        expect(app.text('external-detached-date')).toMatch(/^Decisione registrata il 10 gen 2030/);
    });
});

describe('agenda: calendario e conflitti', () => {
    const overlapping = [
        studioEvent({ id: 'e1', title: 'Primo', start: '2030-01-15T09:00:00', end: '2030-01-15T10:00:00' }),
        studioEvent({ id: 'e2', title: 'Secondo', start: '2030-01-15T09:30:00', end: '2030-01-15T10:30:00' }),
        studioEvent({ id: 'e3', title: 'Adiacente', start: '2030-01-15T10:30:00', end: '2030-01-15T11:00:00' })
    ];

    it('segnala le sovrapposizioni con banner e prefisso nel calendario', async () => {
        await loggedIn({ events: overlapping });
        expect(app.isHidden('calendar-conflict-banner')).toBe(false);
        expect(app.text('conflict-banner-text')).toBe('Attenzione: Rilevate 1 sovrapposizioni orarie in agenda!');
        const byId = Object.fromEntries(app.calendar.renderedEvents.map(e => [e.id, e]));
        expect(byId.e1.title).toBe('⚠️ [CONFLITTO] Primo');
        expect(byId.e1.borderColor).toBe('#dc2626');
        expect(byId.e2.title).toBe('⚠️ [CONFLITTO] Secondo');
        expect(byId.e3.title).toBe('Adiacente'); // eventi che si toccano non sono in conflitto
    });

    it('scrollToConflict porta il calendario al primo conflitto in vista settimanale', async () => {
        await loggedIn({ events: overlapping });
        app.window.scrollToConflict();
        expect(app.calendar.calls).toContainEqual(['gotoDate', new Date('2030-01-15T09:00:00').toISOString()]);
        expect(app.calendar.view).toBe('timeGridWeek');
    });

    it('nasconde il banner senza sovrapposizioni', async () => {
        await loggedIn({ events: [overlapping[0], overlapping[2]] });
        expect(app.isHidden('calendar-conflict-banner')).toBe(true);
    });

    it('usa il colore della sede e i prefissi per eventi non clinici e mantenuti', async () => {
        await loggedIn({
            events: [
                studioEvent({ id: 'a', title: 'Paziente', start: '2030-02-01T09:00:00', end: '2030-02-01T10:00:00', extendedProps: { centerId: 'c1' } }),
                studioEvent({ id: 'b', title: 'Palestra', start: '2030-02-02T09:00:00', end: '2030-02-02T10:00:00', extendedProps: { centerId: 'c2' } }),
                studioEvent({ id: 'c', title: 'Tenuto', start: '2030-02-03T09:00:00', end: '2030-02-03T10:00:00', extendedProps: { detachedFromExternal: true } })
            ]
        });
        const byId = Object.fromEntries(app.calendar.renderedEvents.map(e => [e.id, e]));
        expect(byId.a.backgroundColor).toBe('#4a8fa8');
        expect(byId.b.title).toBe('🏠 [NON CLINICO] Palestra');
        expect(byId.c.title).toBe('📌 [MANTENUTO] Tenuto');
    });

    it('cliccando un evento del calendario si apre il modulo di modifica', async () => {
        await loggedIn({ events: overlapping });
        app.calendar.clickEvent('e1');
        expect(app.isHidden('studio-modal')).toBe(false);
        expect(app.byId('studio-edit-event-id').value).toBe('e1');
        expect(app.byId('studio-title').value).toBe('Primo');
    });

    it('usa la vista agenda (listWeek) sotto i 768px', async () => {
        app = await bootApp({ docs: seedDocs({ centers }), width: 400 });
        await app.login();
        expect(app.calendar.options.initialView).toBe('listWeek');
        expect(app.calendar.options.height).toBe('auto');
    });

    it('elimina un appuntamento dopo conferma, inclusa la seduta clinica', async () => {
        await loggedIn({ events: [studioEvent({ id: 'del', extendedProps: { patientId: 'pat_1', clinicalNote: 'n' } })], clinicalSessions: [{ id: 'del', eventId: 'del', patientId: 'pat_1', clinicalNote: 'n' }] });
        app.window.openStudioModal(app.state.events[0]);
        app.window.confirmDeleteStudioEvent();
        expect(app.isHidden('confirm-modal')).toBe(false);
        expect(app.text('confirm-title')).toBe('Elimina Appuntamento');
        await app.confirm();
        expect(app.isHidden('confirm-modal')).toBe(true);
        expect(app.isHidden('studio-modal')).toBe(true);
        expect(app.mock.has(`${SHARED}/studio_events/del`)).toBe(false);
        expect(app.mock.has(`${SHARED}/clinical_sessions/del`)).toBe(false);
        expect(app.state.events).toHaveLength(0);
        expect(app.toast()).toBe('Appuntamento eliminato.');
    });

    it('annullando la conferma non elimina nulla', async () => {
        await loggedIn({ events: [studioEvent({ id: 'keep' })] });
        app.window.openStudioModal(app.state.events[0]);
        app.window.confirmDeleteStudioEvent();
        app.byId('confirm-cancel-btn').click();
        await app.flush();
        expect(app.isHidden('confirm-modal')).toBe(true);
        expect(app.mock.has(`${SHARED}/studio_events/keep`)).toBe(true);
    });

    it('la sincronizzazione realtime aggiorna l’agenda quando un altro dispositivo aggiunge un evento', async () => {
        await loggedIn();
        app.mock.seed({ [`${SHARED}/studio_events/remote`]: studioEvent({ id: 'remote', title: 'Da altro dispositivo' }) });
        await app.flush();
        expect(app.state.events.map(e => e.id)).toEqual(['remote']);
        expect(app.calendar.renderedEvents.map(e => e.id)).toEqual(['remote']);
    });
});
