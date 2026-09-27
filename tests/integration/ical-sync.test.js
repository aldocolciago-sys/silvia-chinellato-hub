import { describe, it, expect, afterEach, vi } from 'vitest';
import { bootApp, SHARED } from '../support/jsdom-app.js';
import { seedDocs, center, patient, studioEvent } from '../fixtures/seed.js';
import { vcalendar, vevent } from '../fixtures/ical.js';

let app;
afterEach(() => app?.close());

const ICAL_URL = 'https://calendari.example.com/polisalute.ics';
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const textResponse = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/calendar' } });

/** fetch simulato: `calendars` è una funzione (url) => testo ICS | Response | null. */
function fakeFetch(calendars) {
    return vi.fn(async (endpoint) => {
        const url = decodeURIComponent(String(endpoint).replace(/^\/api\/ical\?url=/, ''));
        if (!String(endpoint).startsWith('/api/ical')) throw new TypeError('rete esterna bloccata nei test');
        const result = calendars(url);
        if (result instanceof Response) return result;
        if (result == null) return jsonResponse({ error: 'Errore HTTP 404' }, 404);
        return jsonResponse({ icsContent: result });
    });
}

async function setup({ ics, fetchImpl, centers = [center({ id: 'c1', name: 'Polisalute', color: '#4a8fa8', icalUrl: ICAL_URL })], ...data } = {}) {
    let currentIcs = ics;
    const fetchMock = fetchImpl || fakeFetch(() => currentIcs);
    app = await bootApp({ docs: seedDocs({ centers, ...data }), fetch: fetchMock });
    await app.login();
    return { fetchMock, setIcs: (value) => { currentIcs = value; } };
}

const calendarWith = (...events) => vcalendar(events.map(vevent));
const reportFromStorage = () => JSON.parse(app.window.localStorage.getItem('lastIcalSyncReport'));
const closeButton = () => app.$('#sync-modal-footer button');

describe('sincronizzazione iCal', () => {
    it('importa gli eventi, associa i pazienti per nome e salva su Firestore', async () => {
        const { fetchMock } = await setup({
            ics: calendarWith(
                { uid: 'u1', summary: 'Mario Rossi', start: '20300115T090000Z', end: '20300115T100000Z' },
                { uid: 'u2', summary: 'Sconosciuto', start: '20300116T140000Z' }
            ),
            patients: [patient({ id: 'pat_1', name: 'Mario Rossi' })]
        });
        expect(fetchMock).toHaveBeenCalledWith(`/api/ical?url=${encodeURIComponent(ICAL_URL)}`);
        const saved = app.mock.list(`${SHARED}/studio_events`);
        expect(saved.map(e => e.id).sort()).toEqual(['ical_c1_u1', 'ical_c1_u2']);
        const e1 = saved.find(e => e.id === 'ical_c1_u1');
        expect(e1).toMatchObject({ title: 'Mario Rossi', start: '2030-01-15T09:00:00.000Z', end: '2030-01-15T10:00:00.000Z', backgroundColor: '#4a8fa8', extendedProps: { centerId: 'c1', centerName: 'Polisalute', patientId: 'pat_1', isNonClinical: false } });
        const e2 = saved.find(e => e.id === 'ical_c1_u2');
        expect(e2.end).toBe('2030-01-16T15:00:00.000Z'); // DTEND mancante → +1 ora
        expect(e2.extendedProps.patientId).toBeNull();

        expect(app.text('sync-modal-title')).toBe('Sincronizzazione completata');
        expect(app.text('sync-report-content')).toContain('Aggiunti (2)');
        expect(reportFromStorage()).toMatchObject({ centers: ['Polisalute'], modified: [], deleted: [] });
        expect(reportFromStorage().added).toHaveLength(2);
        expect(closeButton().disabled).toBe(false);
        expect(closeButton().textContent).toBe('Ho capito');
        expect(app.calendar.renderedEvents).toHaveLength(2);
    });

    it('rileva gli appuntamenti modificati alla sincronizzazione successiva', async () => {
        const { setIcs } = await setup({ ics: calendarWith({ uid: 'u1', summary: 'Visita', start: '20300115T090000Z', end: '20300115T100000Z' }) });
        app.window.closeSyncReportModal();
        setIcs(calendarWith({ uid: 'u1', summary: 'Visita', start: '20300115T110000Z', end: '20300115T120000Z' }));
        await app.window.triggerIcalSync();
        await app.flush();
        expect(app.text('sync-modal-title')).toBe('Sincronizzazione completata');
        const report = reportFromStorage();
        expect(report.added).toHaveLength(0);
        expect(report.modified).toHaveLength(1);
        expect(app.mock.get(`${SHARED}/studio_events/ical_c1_u1`).start).toBe('2030-01-15T11:00:00.000Z');
    });

    it('mantiene il paziente già associato quando l’evento viene aggiornato', async () => {
        await setup({
            ics: calendarWith({ uid: 'u1', summary: 'Nome diverso', start: '20300115T090000Z' }),
            events: [studioEvent({ id: 'ical_c1_u1', title: 'Nome diverso', start: '2030-01-15T09:00:00.000Z', end: '2030-01-15T10:00:00.000Z', extendedProps: { centerId: 'c1', patientId: 'pat_x' } })]
        });
        expect(app.mock.get(`${SHARED}/studio_events/ical_c1_u1`).extendedProps.patientId).toBe('pat_x');
    });

    it('richiede una decisione per gli appuntamenti rimossi alla fonte: mantieni', async () => {
        await setup({
            ics: calendarWith(),
            events: [studioEvent({ id: 'ical_c1_gone', title: 'Rimosso', start: '2030-01-15T09:00:00.000Z', end: '2030-01-15T10:00:00.000Z', extendedProps: { centerId: 'c1', centerName: 'Polisalute' } })]
        });
        expect(app.text('sync-report-content')).toContain('Scelta obbligatoria');
        expect(closeButton().disabled).toBe(true);
        expect(closeButton().textContent).toBe('Completa 1 scelte');
        app.window.closeSyncReportModal();
        expect(app.isHidden('sync-report-modal')).toBe(false);
        expect(app.toast()).toBe('Completa prima tutte le scelte sugli appuntamenti rimossi.');

        app.window.requestExternalDeletionDecision('ical_c1_gone', 'keep');
        expect(app.text('confirm-ok-btn')).toBe('Sì, mantieni');
        await app.confirm();
        const kept = app.mock.get(`${SHARED}/studio_events/ical_c1_gone`);
        expect(kept.extendedProps.detachedFromExternal).toBe(true);
        expect(kept.extendedProps.notes).toMatch(/^\[STATO CALENDARIO\] Cancellato dal calendario originale/);
        expect(reportFromStorage().deleted[0].decision).toBe('keep');
        expect(app.text('sync-report-content')).toContain('Scelta registrata: mantieni nella mia agenda');
        expect(closeButton().disabled).toBe(false);
        app.window.closeSyncReportModal();
        expect(app.isHidden('sync-report-modal')).toBe(true);
    });

    it('un evento mantenuto non viene più proposto come rimosso', async () => {
        await setup({
            ics: calendarWith(),
            events: [studioEvent({ id: 'ical_c1_kept', extendedProps: { centerId: 'c1', detachedFromExternal: true } })]
        });
        expect(reportFromStorage().deleted).toHaveLength(0);
    });

    it('richiede una decisione per gli appuntamenti rimossi alla fonte: rimuovi', async () => {
        await setup({
            ics: calendarWith(),
            events: [studioEvent({ id: 'ical_c1_gone', title: 'Rimosso', start: '2030-01-15T09:00:00.000Z', extendedProps: { centerId: 'c1' } })]
        });
        app.window.requestExternalDeletionDecision('ical_c1_gone', 'remove');
        expect(app.text('confirm-ok-btn')).toBe('Sì, rimuovi');
        await app.confirm();
        expect(app.mock.has(`${SHARED}/studio_events/ical_c1_gone`)).toBe(false);
        expect(app.state.events).toHaveLength(0);
        expect(reportFromStorage().deleted[0].decision).toBe('remove');
    });

    it('non registra la decisione se il salvataggio fallisce e riabilita la conferma', async () => {
        await setup({ ics: calendarWith(), events: [studioEvent({ id: 'ical_c1_gone', extendedProps: { centerId: 'c1' } })] });
        app.mock.failNext('setDoc', `${SHARED}/studio_events/ical_c1_gone`);
        app.window.requestExternalDeletionDecision('ical_c1_gone', 'keep');
        await app.confirm();
        expect(app.toast()).toBe('Errore: operazione non completata.');
        expect(app.isHidden('confirm-modal')).toBe(false);
        expect(reportFromStorage().deleted[0].decision).toBeNull();
    });

    it('ripiega sui proxy alternativi se /api/ical non risponde', async () => {
        const ics = calendarWith({ uid: 'u1', summary: 'Da proxy', start: '20300115T090000Z' });
        const fetchMock = vi.fn(async (endpoint) => {
            if (endpoint.startsWith('/api/ical')) return jsonResponse({ error: 'down' }, 500);
            if (endpoint.startsWith('https://api.allorigins.win/raw')) return textResponse(ics);
            throw new TypeError('non previsto');
        });
        await setup({ fetchImpl: fetchMock });
        expect(fetchMock.mock.calls.map(c => c[0].split('?')[0])).toEqual(['/api/ical', 'https://api.allorigins.win/raw']);
        expect(app.mock.has(`${SHARED}/studio_events/ical_c1_u1`)).toBe(true);
    });

    it('prova in ordine tutti i proxy se nessuno restituisce un calendario', async () => {
        const fetchMock = vi.fn(async () => textResponse('<html>login</html>'));
        await setup({ fetchImpl: fetchMock });
        expect(fetchMock).toHaveBeenCalledTimes(4);
        expect(fetchMock.mock.calls.map(c => c[0].split('?')[0])).toEqual(['/api/ical', 'https://api.allorigins.win/raw', 'https://corsproxy.io/', ICAL_URL]);
        expect(app.mock.list(`${SHARED}/studio_events`)).toHaveLength(0);
    });

    // KNOWN BUG: il badge "Errore" viene sostituito dal report finale nello stesso tick
    // (quindi non è mai visibile) e il report non indica che la sede non è stata
    // sincronizzata: appare come "Nessuna variazione".
    it.fails('il report finale segnala le sedi non sincronizzate', async () => {
        await setup({ fetchImpl: vi.fn(async () => { throw new TypeError('offline'); }) });
        expect(app.text('sync-report-content')).toMatch(/errore|non sincronizzat/i);
    });

    // KNOWN BUG: se il download di un calendario fallisce, tutti gli eventi già importati
    // da quella sede vengono proposti come "rimossi dal calendario originale".
    it.fails('un errore di rete non segnala gli eventi della sede come rimossi alla fonte', async () => {
        await setup({
            fetchImpl: vi.fn(async () => { throw new TypeError('offline'); }),
            events: [studioEvent({ id: 'ical_c1_x', extendedProps: { centerId: 'c1' } })]
        });
        expect(reportFromStorage().deleted).toHaveLength(0);
    });

    it('normalizza gli URL di condivisione Google prima di scaricarli', async () => {
        const fetchMock = fakeFetch(() => calendarWith());
        await setup({ fetchImpl: fetchMock, centers: [center({ id: 'c1', icalUrl: ' https://calendar.google.com/calendar/u/0?cid=c2lsdmlhY2hpbmVAZ21haWwuY29t ' })] });
        expect(decodeURIComponent(fetchMock.mock.calls[0][0])).toBe('/api/ical?url=https://calendar.google.com/calendar/ical/silviachine@gmail.com/public/basic.ics');
    });

    it('gli eventi di un calendario non clinico non vengono associati a pazienti', async () => {
        await setup({
            centers: [center({ id: 'c9', name: 'Personale', isNonClinicalCalendar: true, icalUrl: ICAL_URL })],
            ics: calendarWith({ uid: 'x', summary: 'Cena con Mario Rossi', start: '20300115T190000Z' }),
            patients: [patient({ id: 'pat_1', name: 'Mario Rossi' })]
        });
        expect(app.mock.get(`${SHARED}/studio_events/ical_c9_x`).extendedProps).toMatchObject({ patientId: null, isNonClinical: true });
    });

    it('sincronizza più sedi e crea un riepilogo per ciascuna', async () => {
        const urls = { a: 'https://a.example/a.ics', b: 'https://b.example/b.ics' };
        await setup({
            centers: [center({ id: 'ca', name: 'Sede A', icalUrl: urls.a }), center({ id: 'cb', name: 'Sede B', icalUrl: urls.b }), center({ id: 'cc', name: 'Senza iCal' })],
            fetchImpl: fakeFetch(url => url === urls.a ? calendarWith({ uid: '1', summary: 'A', start: '20300101T090000Z' }) : calendarWith())
        });
        const sections = app.$$('#sync-report-content section h4').map(h => h.textContent);
        expect(sections).toEqual(['Sede A', 'Sede B']);
        expect(app.text('sync-report-content')).toContain('Nessuna variazione');
    });

    it('riapre l’ultimo report salvato', async () => {
        await setup({ ics: calendarWith({ uid: 'u1', summary: 'Visita', start: '20300115T090000Z' }) });
        app.window.closeSyncReportModal();
        app.window.openLastSyncReport();
        expect(app.isHidden('sync-report-modal')).toBe(false);
        expect(app.text('sync-modal-title')).toBe('Novità dell’ultima sincronizzazione');
        expect(app.text('sync-report-content')).toContain('Aggiunti (1)');
    });

    it('senza report salvato mostra un messaggio', async () => {
        app = await bootApp({ docs: seedDocs({ centers: [center()] }) });
        await app.login();
        app.window.localStorage.clear();
        app.window.openLastSyncReport();
        expect(app.text('sync-report-content')).toBe('Nessun report disponibile.');
    });

    // KNOWN BUG: le proprietà con parametri (DTSTART;TZID=Europe/Rome:...) vengono lette come UTC.
    it.fails('rispetta il fuso orario indicato con TZID', async () => {
        await setup({ ics: vcalendar(['BEGIN:VEVENT', 'UID:tz', 'SUMMARY:Roma', 'DTSTART;TZID=Europe/Rome:20300115T090000', 'DTEND;TZID=Europe/Rome:20300115T100000', 'END:VEVENT']) });
        expect(app.mock.get(`${SHARED}/studio_events/ical_c1_tz`).start).toBe('2030-01-15T08:00:00.000Z');
    });

    // KNOWN BUG: le righe "ripiegate" (RFC 5545 §3.1) non vengono ricomposte.
    it.fails('ricompone le righe lunghe ripiegate', async () => {
        await setup({ ics: vcalendar(['BEGIN:VEVENT', 'UID:fold', 'SUMMARY:Trattamento osteopatico per la sig', ' nora Maria Bianchi', 'DTSTART:20300115T090000Z', 'END:VEVENT']) });
        expect(app.mock.get(`${SHARED}/studio_events/ical_c1_fold`).title).toBe('Trattamento osteopatico per la signora Maria Bianchi');
    });

    // KNOWN BUG: i caratteri con escape iCal (\\, \\; \\n) non vengono decodificati.
    it.fails('decodifica i caratteri con escape nel titolo', async () => {
        await setup({ ics: calendarWith({ uid: 'esc', summary: 'Rossi\\, Mario', start: '20300115T090000Z' }) });
        expect(app.mock.get(`${SHARED}/studio_events/ical_c1_esc`).title).toBe('Rossi, Mario');
    });
});
