import { describe, it, expect } from 'vitest';
import {
    computeCalendarSync, parseIcsEvents, icalEventId, defaultIcalFee, eventTreatment, eventPatch, pendingRemovalEvents,
    appendRecentChanges, centerKind, isValidCalendarText, MASS_REMOVAL_MIN
} from '../../lib/calendar-sync-core.js';
import { vcalendar, vevent } from '../fixtures/ical.js';

const NOW = new Date('2030-01-10T12:00:00.000Z');
const CENTER = { id: 'c1', name: 'CMS Carate', color: '#4a8fa8', icalUrl: 'https://cal.example/c1.ics', service: 'Idrocolonterapia', rateIdrocolonterapia: 45 };
const cal = (...events) => vcalendar(events.map(vevent));
const synced = (overrides = {}) => {
    const { extendedProps, ...rest } = overrides;
    return {
        id: 'ical_c1_u1', title: 'Mario Rossi', start: '2030-01-15T09:00:00.000Z', end: '2030-01-15T10:00:00.000Z',
        backgroundColor: '#4a8fa8', borderColor: '#4a8fa8', textColor: '#ffffff', ...rest,
        extendedProps: { centerId: 'c1', centerName: 'CMS Carate', patientId: 'p1', isNonClinical: false, fee: 45, ...(extendedProps || {}) }
    };
};
const run = (input) => computeCalendarSync({ centers: [CENTER], now: NOW, ...input });

describe('parseIcsEvents', () => {
    it('legge UID, titolo, orari, eccezioni e stato, ignorando i componenti annidati', () => {
        const ics = vcalendar([
            ['BEGIN:VEVENT', 'UID:a', 'SUMMARY:Visita', 'DTSTART;TZID=Europe/Rome:20300115T090000', 'DTEND:20300115T100000Z',
                'BEGIN:VALARM', 'ACTION:EMAIL', 'SUMMARY:Allarme', 'BEGIN:X-ANNIDATO', 'END:X-ANNIDATO', 'END:VALARM',
                'RECURRENCE-ID:20300115T080000Z', 'STATUS:cancelled', 'END:VEVENT'].join('\r\n'),
            'BEGIN:VEVENT\r\nDESCRIPTION:solo descrizione\r\nEND:VEVENT',
            'BEGIN:VEVENT\r\nriga senza due punti\r\nSUMMARY:Senza UID\r\nEND:VEVENT'
        ]);
        expect(parseIcsEvents(ics)).toEqual([
            { uid: 'a', recurrenceId: '20300115T080000Z', summary: 'Visita', start: '20300115T090000', startTzid: 'Europe/Rome', end: '20300115T100000Z', endTzid: null, status: 'CANCELLED' },
            { uid: null, recurrenceId: null, summary: 'Senza UID', start: null, startTzid: null, end: null, endTzid: null, status: null }
        ]);
    });

    it('riconosce un testo che è un calendario', () => {
        expect(isValidCalendarText('BEGIN:VCALENDAR')).toBe(true);
        expect(isValidCalendarText('<html>')).toBe(false);
        expect(isValidCalendarText(null)).toBe(false);
    });
});

describe('icalEventId', () => {
    it('usa il UID, aggiunge l’eccezione della serie e sostituisce le "/"', () => {
        expect(icalEventId('c1', { uid: 'x@google.com' })).toBe('ical_c1_x@google.com');
        expect(icalEventId('c1', { uid: 'x', recurrenceId: '20300115T080000Z' })).toBe('ical_c1_x_r20300115T080000Z');
        expect(icalEventId('c1', { uid: 'a/b' })).toBe('ical_c1_a_b');
    });

    it('senza UID crea un id stabile da titolo e inizio', () => {
        const a = icalEventId('c1', { summary: 'Visita', start: '20300115T090000Z' });
        expect(a).toMatch(/^ical_c1_nouid-[0-9a-f]{8}$/);
        expect(icalEventId('c1', { summary: 'Visita', start: '20300115T090000Z' })).toBe(a);
        expect(icalEventId('c1', { summary: 'Visita', start: '20300116T090000Z' })).not.toBe(a);
        expect(icalEventId('c1', {})).toMatch(/^ical_c1_nouid-/);
    });
});

describe('compenso e trattamento', () => {
    it('turni: durata × tariffa oraria', () => {
        const shift = { isNonClinicalCalendar: true, isShiftCalendar: true, hourlyRate: 30 };
        expect(defaultIcalFee({ start: '2030-01-15T08:00:00Z', end: '2030-01-15T13:30:00Z' }, shift)).toBe(165);
        expect(defaultIcalFee({ start: '2030-01-15T08:00:00Z', end: '2030-01-15T08:00:00Z' }, shift)).toBe(0);
        expect(defaultIcalFee({ start: 'x', end: 'y' }, { ...shift, hourlyRate: undefined })).toBe(0);
    });

    it('sedi cliniche: tariffa del trattamento, o l’unica tariffa della sede', () => {
        const center = { rateOsteopatia: 50, rateIdrocolonterapia: 40 };
        expect(defaultIcalFee({ title: 'Osteopatia Rossi' }, center)).toBe(50);
        expect(defaultIcalFee({ title: 'Seduta', extendedProps: { treatment: 'idrocolonterapia' } }, center)).toBe(40);
        expect(defaultIcalFee({ title: 'Seduta' }, center)).toBe(0);
        expect(defaultIcalFee({ title: 'Seduta' }, { rateOsteopatia: 50 })).toBe(50);
    });

    it('calendari personali e sedi sconosciute: nessun compenso', () => {
        expect(defaultIcalFee({ title: 'Osteopatia' }, { isNonClinicalCalendar: true, rateOsteopatia: 50 })).toBe(0);
        expect(defaultIcalFee({ title: 'Osteopatia', extendedProps: { isNonClinical: true } }, { rateOsteopatia: 50 })).toBe(0);
        expect(defaultIcalFee({ title: 'Osteopatia' }, null)).toBe(0);
    });

    it('riconosce il trattamento dal servizio o dal nome della sede, anche con accenti', () => {
        expect(eventTreatment({ title: 'Mario' }, { service: 'IDROCOLON terapia' })).toBe('idrocolonterapia');
        expect(eventTreatment({ title: 'Mario', extendedProps: { centerName: 'Studio Osteopàtico' } }, null)).toBe('osteopatia');
        expect(eventTreatment({ title: 'Mario' }, { name: 'Palestra' })).toBeNull();
    });

    it('tipo di calendario della sede', () => {
        expect(centerKind({ isNonClinicalCalendar: true, isShiftCalendar: true })).toBe('shift');
        expect(centerKind({ isNonClinicalCalendar: true })).toBe('personal');
        expect(centerKind({})).toBe('clinical');
    });
});

describe('computeCalendarSync', () => {
    it('aggiunge i nuovi appuntamenti con paziente, colore e compenso', () => {
        const result = run({
            feeds: { c1: cal({ uid: 'u1', summary: 'Mario Rossi', start: '20300115T090000Z' }) },
            patients: [{ id: 'p0', name: '' }, { id: 'p1', name: 'Mario Rossi' }]
        });
        expect(result.writes).toHaveLength(1);
        expect(result.writes[0]).toMatchObject({ id: 'ical_c1_u1', isNew: true, data: synced() });
        expect(result.writes[0].patch['extendedProps.fee']).toBe(45);
        expect(result.changes).toEqual([{ type: 'added', kind: 'clinical', id: 'ical_c1_u1', title: 'Mario Rossi', start: '2030-01-15T09:00:00.000Z', end: '2030-01-15T10:00:00.000Z', centerId: 'c1', centerName: 'CMS Carate', patientId: 'p1', treatment: null }]);
        expect(result.centers).toEqual([{ id: 'c1', name: 'CMS Carate', ok: true, added: 1, modified: 0, removed: 0, restored: 0, suspicious: false }]);
    });

    it('non scrive nulla se il calendario non è cambiato', () => {
        const result = run({ events: [synced()], feeds: { c1: cal({ uid: 'u1', summary: 'Mario Rossi', start: '20300115T090000Z', end: '20300115T100000Z' }) } });
        expect(result.writes).toEqual([]);
        expect(result.changes).toEqual([]);
    });

    it('aggiorna gli spostati conservando i dati inseriti a mano e scrive solo i campi cambiati', () => {
        const existing = synced({ extendedProps: { paymentStatus: 'paid', notes: 'nota', fee: 60 } });
        const result = run({ events: [existing], feeds: { c1: cal({ uid: 'u1', summary: 'Mario Rossi', start: '20300115T110000Z', end: '20300115T120000Z' }) } });
        expect(result.writes[0].patch).toEqual({ start: '2030-01-15T11:00:00.000Z', end: '2030-01-15T12:00:00.000Z' });
        expect(result.writes[0].data.extendedProps).toMatchObject({ paymentStatus: 'paid', notes: 'nota', fee: 60, patientId: 'p1' });
        expect(result.changes[0]).toMatchObject({ type: 'modified', before: { title: 'Mario Rossi', start: '2030-01-15T09:00:00.000Z', end: '2030-01-15T10:00:00.000Z' } });
    });

    it('aggiorna in silenzio colore e nome della sede cambiati', () => {
        const result = run({ centers: [{ ...CENTER, color: '#000000', name: 'CMS Nuovo' }], events: [synced()], feeds: { c1: cal({ uid: 'u1', summary: 'Mario Rossi', start: '20300115T090000Z', end: '20300115T100000Z' }) } });
        expect(result.writes[0].patch).toEqual({ backgroundColor: '#000000', borderColor: '#000000', 'extendedProps.centerName': 'CMS Nuovo' });
        expect(result.changes).toEqual([]);
    });

    it('segna come "da decidere" gli appuntamenti spariti, senza toglierli, e non li segnala due volte', () => {
        const first = run({ events: [synced()], feeds: { c1: cal() } });
        expect(first.writes).toEqual([{ id: 'ical_c1_u1', isNew: false, patch: { 'extendedProps.externalRemovalPending': true, 'extendedProps.externalRemovalDetectedAt': NOW.toISOString() }, data: expect.objectContaining({ title: 'Mario Rossi' }) }]);
        expect(first.writes[0].data.extendedProps).toMatchObject({ externalRemovalPending: true, fee: 45 });
        expect(first.changes[0]).toMatchObject({ type: 'removed', id: 'ical_c1_u1' });
        const second = run({ events: [first.writes[0].data], feeds: { c1: cal() } });
        expect(second.writes).toEqual([]);
        expect(second.changes).toEqual([]);
    });

    it('se l’appuntamento ricompare, toglie il segno "da decidere"', () => {
        const pending = synced({ extendedProps: { externalRemovalPending: true, externalRemovalDetectedAt: 'x' } });
        const same = run({ events: [pending], feeds: { c1: cal({ uid: 'u1', summary: 'Mario Rossi', start: '20300115T090000Z', end: '20300115T100000Z' }) } });
        expect(same.writes[0].patch).toEqual({ 'extendedProps.externalRemovalPending': false, 'extendedProps.externalRemovalDetectedAt': null });
        expect(same.changes).toEqual([expect.objectContaining({ type: 'restored' })]);
        expect(same.changes[0].before).toBeUndefined();
        const moved = run({ events: [pending], feeds: { c1: cal({ uid: 'u1', summary: 'Mario Rossi', start: '20300116T090000Z' }) } });
        expect(moved.changes[0]).toMatchObject({ type: 'restored', before: { start: '2030-01-15T09:00:00.000Z' } });
    });

    it('un appuntamento mantenuto che ricompare torna sincronizzato con tutti i suoi dati', () => {
        const kept = synced({ extendedProps: { detachedFromExternal: true, externalCalendarStatus: 'x', externalRemovedAt: 'y', notes: 'mia nota\n[STATO CALENDARIO] mantenuto' } });
        const result = run({ events: [kept], feeds: { c1: cal({ uid: 'u1', summary: 'Mario Rossi', start: '20300115T090000Z', end: '20300115T100000Z' }) } });
        expect(result.writes[0].data.extendedProps).toMatchObject({ detachedFromExternal: false, externalCalendarStatus: null, externalRemovedAt: null, notes: 'mia nota', fee: 45 });
        expect(result.changes).toEqual([]);
        // Un mantenuto ancora assente dal calendario resta com'è.
        expect(run({ events: [kept], feeds: { c1: cal() } }).writes).toEqual([]);
    });

    it('un mantenuto senza note di testo non viene toccato nelle note', () => {
        const kept = synced({ extendedProps: { detachedFromExternal: true } });
        const result = run({ events: [kept], feeds: { c1: cal({ uid: 'u1', summary: 'Mario Rossi', start: '20300115T090000Z', end: '20300115T100000Z' }) } });
        expect(result.writes[0].data.extendedProps.notes).toBeUndefined();
    });

    it('un calendario non scaricato non tocca gli appuntamenti della sua sede', () => {
        const result = run({ events: [synced()], feeds: { c1: null } });
        expect(result).toMatchObject({ writes: [], changes: [], failed: ['CMS Carate'] });
        expect(result.centers[0].ok).toBe(false);
        expect(run({ events: [synced()], feeds: { c1: '<html>login</html>' } }).failed).toEqual(['CMS Carate']);
    });

    it('ignora le sedi senza calendario e gli appuntamenti di altre sedi', () => {
        const other = synced({ id: 'ical_c2_x', extendedProps: { centerId: 'c2' } });
        const result = run({ centers: [CENTER, { id: 'c2', name: 'Senza link' }], events: [other, { id: 'manuale', start: '2030-01-15T09:00:00' }, null], feeds: { c1: cal() } });
        expect(result.writes).toEqual([]);
        expect(result.centers.map(c => c.id)).toEqual(['c1']);
    });

    it('salta gli eventi annullati, senza data valida e con le eccezioni di una serie tiene id distinti', () => {
        const ics = vcalendar([
            vevent({ uid: 's', summary: 'Serie', start: '20300115T090000Z' }),
            vevent({ uid: 's', summary: 'Eccezione', start: '20300122T110000Z', extra: ['RECURRENCE-ID:20300122T090000Z'] }),
            vevent({ uid: 'x', summary: 'Annullato', start: '20300116T090000Z', extra: ['STATUS:CANCELLED'] }),
            vevent({ uid: 'y', summary: 'Senza data' }),
            vevent({ uid: 'z', start: '20300117T090000Z' })
        ]);
        const result = run({ feeds: { c1: ics } });
        expect(result.writes.map(w => w.id)).toEqual(['ical_c1_s', 'ical_c1_s_r20300122T090000Z', 'ical_c1_z']);
        expect(result.writes[2].data.title).toBe('Appuntamento');
    });

    it('nei calendari personali non associa pazienti e non mette compensi', () => {
        const personal = { ...CENTER, isNonClinicalCalendar: true };
        const result = run({ centers: [personal], feeds: { c1: cal({ uid: 'u1', summary: 'Cena con Mario Rossi', start: '20300115T190000Z' }) }, patients: [{ id: 'p1', name: 'Mario Rossi' }] });
        expect(result.writes[0].data.extendedProps).toEqual({ centerId: 'c1', centerName: 'CMS Carate', patientId: null, isNonClinical: true });
        expect(result.changes[0].kind).toBe('personal');
    });

    it('senza funzione del compenso non ne mette uno', () => {
        const result = run({ feeFor: null, feeds: { c1: cal({ uid: 'u1', summary: 'Visita', start: '20300115T090000Z' }) } });
        expect(result.writes[0].data.extendedProps.fee).toBeUndefined();
    });

    describe('sincronizzazione automatica (finestra e sparizioni in blocco)', () => {
        const future = (i) => synced({ id: `ical_c1_f${i}`, title: `F${i}`, start: `2030-01-${String(20 + i).padStart(2, '0')}T09:00:00.000Z` });

        it('con la finestra ignora gli eventi vecchi del calendario che non sono stati letti', () => {
            const result = run({ windowStart: '2030-01-08T23:00:00.000Z', feeds: { c1: cal({ uid: 'old', summary: 'Vecchio', start: '20290101T090000Z' }, { uid: 'new', summary: 'Nuovo', start: '20300115T090000Z' }) } });
            expect(result.writes.map(w => w.id)).toEqual(['ical_c1_new']);
        });

        it('non segna nulla se spariscono in blocco molti appuntamenti futuri', () => {
            const events = Array.from({ length: MASS_REMOVAL_MIN }, (_, i) => future(i));
            const result = run({ guardMassRemoval: true, events, feeds: { c1: cal({ uid: 'altro', summary: 'Altro', start: '20290101T090000Z' }) } });
            expect(result.suspicious).toEqual([{ centerId: 'c1', name: 'CMS Carate', count: MASS_REMOVAL_MIN }]);
            expect(result.writes.filter(w => !w.isNew)).toEqual([]);
            expect(result.centers[0].suspicious).toBe(true);
            // Senza protezione (pulsante "Sincronizza" dell'app) vengono segnati.
            expect(run({ events, feeds: { c1: cal() } }).changes.filter(c => c.type === 'removed')).toHaveLength(MASS_REMOVAL_MIN);
        });

        it('un calendario arrivato vuoto è sospetto anche con un solo appuntamento futuro', () => {
            const result = run({ guardMassRemoval: true, events: [future(1)], feeds: { c1: cal() } });
            expect(result.suspicious).toEqual([{ centerId: 'c1', name: 'CMS Carate', count: 1 }]);
        });

        it('poche cancellazioni o solo appuntamenti passati vengono segnate normalmente', () => {
            const events = [future(1), future(2), future(3), synced({ id: 'ical_c1_past', start: '2030-01-01T09:00:00.000Z' })];
            const ics = cal({ uid: 'f2', summary: 'F2', start: '20300122T090000Z', end: '20300122T100000Z' }, { uid: 'f3', summary: 'F3', start: '20300123T090000Z', end: '20300123T100000Z' });
            const result = run({ guardMassRemoval: true, events, feeds: { c1: ics } });
            expect(result.suspicious).toEqual([]);
            expect(result.changes.filter(c => c.type === 'removed').map(c => c.id).sort()).toEqual(['ical_c1_f1', 'ical_c1_past']);
        });

        it('con un calendario vuoto e solo appuntamenti passati la cancellazione è segnata', () => {
            const result = run({ guardMassRemoval: true, events: [synced({ start: '2030-01-01T09:00:00.000Z' })], feeds: { c1: cal() } });
            expect(result.suspicious).toEqual([]);
            expect(result.changes[0].type).toBe('removed');
        });
    });
});

describe('funzioni di supporto', () => {
    it('eventPatch confronta anche oggetti e liste', () => {
        expect(eventPatch({ a: [1], extendedProps: { x: { y: 1 } } }, { a: [1], extendedProps: { x: { y: 2 } } })).toEqual({ 'extendedProps.x': { y: 2 } });
        expect(eventPatch(undefined, { a: 1 })).toEqual({ a: 1 });
        expect(eventPatch({ a: 1, extendedProps: { b: 1 } }, {})).toEqual({ a: null, 'extendedProps.b': null });
    });

    it('pendingRemovalEvents ordina per data ed esclude i mantenuti', () => {
        const events = [
            { id: 'b', start: '2030-02-01', extendedProps: { externalRemovalPending: true } },
            { id: 'a', start: '2030-01-01', extendedProps: { externalRemovalPending: true } },
            { id: 'k', extendedProps: { externalRemovalPending: true, detachedFromExternal: true } },
            { id: 'n', extendedProps: {} }, null, { id: 'z', extendedProps: { externalRemovalPending: true } }
        ];
        expect(pendingRemovalEvents(events).map(e => e.id)).toEqual(['z', 'a', 'b']);
        expect(pendingRemovalEvents()).toEqual([]);
    });

    it('appendRecentChanges mette le novità in cima, scarta le vecchie e limita la lunghezza', () => {
        const old = [{ id: 'vecchio', at: '2029-12-01T00:00:00.000Z' }, { id: 'recente', at: '2030-01-09T00:00:00.000Z' }, null];
        expect(appendRecentChanges(old, [{ id: 'nuovo' }], { now: NOW }).map(c => c.id)).toEqual(['nuovo', 'recente']);
        expect(appendRecentChanges('non una lista', [{ id: 'a' }, { id: 'b' }], { now: NOW, max: 1 })).toEqual([{ id: 'a', at: NOW.toISOString() }]);
        expect(appendRecentChanges()).toEqual([]);
    });
});
