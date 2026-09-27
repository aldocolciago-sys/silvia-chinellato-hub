import { describe, it, expect } from 'vitest';
import { loadFunctions } from '../support/app-source.js';

const centers = [
    { id: 'cms', name: 'CMS - Carate Brianza', service: 'Idrocolonterapia' },
    { id: 'sport', name: 'Medicina dello Sport', isNonClinicalCalendar: true, isShiftCalendar: true },
    { id: 'casa', name: 'Agenda personale', isNonClinicalCalendar: true }
];
const patients = [
    { id: 'p1', name: 'Mario Rossi', phone: '333 1234567' },
    { id: 'p2', name: 'Anna Senza', phone: '' }
];

function fns(events) {
    const appState = { centers, patients, events };
    return loadFunctions(['tomorrowAppointments', 'todayUpcomingAppointments', 'dayAppointments', 'reminderSentLabel', 'localDayKey', 'isNonClinicalEvent', 'getEventCenter', 'normalizeWhatsAppNumber', 'appointmentContext'], { appState });
}
const ev = (id, start, extendedProps = {}, extra = {}) => ({ id, title: id, start, end: start, extendedProps, ...extra });

describe('tomorrowAppointments', () => {
    it('prende solo gli appuntamenti clinici del giorno dopo, in ordine di orario', () => {
        const events = [
            ev('tardi', '2030-03-05T17:00:00', { patientId: 'p1' }),
            ev('presto', '2030-03-05T08:30:00', { patientId: 'p2', centerId: 'cms' }),
            ev('oggi', '2030-03-04T18:00:00', { patientId: 'p1' }),
            ev('dopodomani', '2030-03-06T08:00:00', { patientId: 'p1' }),
            ev('turno', '2030-03-05T09:00:00', { centerId: 'sport' }),
            ev('personale', '2030-03-05T12:00:00', { centerId: 'casa' }),
            ev('annullato', '2030-03-05T10:00:00', { patientId: 'p1', paymentStatus: 'cancelled' }),
            ev('tutto il giorno', '2030-03-05', {}, { allDay: true }),
            ev('senza paziente', '2030-03-05T11:00:00')
        ];
        const items = fns(events).tomorrowAppointments(new Date(2030, 2, 4, 18, 0));
        expect(items.map(i => i.event.id)).toEqual(['presto', 'senza paziente', 'tardi']);
        expect(items.map(i => [i.patient?.name ?? null, i.hasPhone])).toEqual([['Anna Senza', false], [null, false], ['Mario Rossi', true]]);
    });

    it('funziona a fine mese e con il passaggio all\'ora legale', () => {
        const events = [ev('aprile', '2030-04-01T09:00:00', { patientId: 'p1' }), ev('ora legale', '2030-03-31T09:00:00', { patientId: 'p1' })];
        expect(fns(events).tomorrowAppointments(new Date(2030, 2, 31, 20, 0)).map(i => i.event.id)).toEqual(['aprile']);
        expect(fns(events).tomorrowAppointments(new Date(2030, 2, 30, 23, 30)).map(i => i.event.id)).toEqual(['ora legale']);
    });

    it('riporta quando il promemoria è già stato inviato', () => {
        const items = fns([ev('a', '2030-03-05T09:00:00', { patientId: 'p1', reminderSentAt: '2030-03-04T18:32:00' })]).tomorrowAppointments(new Date(2030, 2, 4, 19, 0));
        expect(items[0].sentAt).toBe('2030-03-04T18:32:00');
    });
});

describe('todayUpcomingAppointments', () => {
    it('prende gli appuntamenti di oggi non ancora iniziati', () => {
        const events = [
            ev('passato', '2030-03-04T09:00:00', { patientId: 'p1' }),
            ev('adesso', '2030-03-04T12:00:00', { patientId: 'p1' }),
            ev('pomeriggio', '2030-03-04T15:00:00', { patientId: 'p1' }),
            ev('domani', '2030-03-05T09:00:00', { patientId: 'p1' }),
            ev('turno', '2030-03-04T16:00:00', { centerId: 'sport' })
        ];
        expect(fns(events).todayUpcomingAppointments(new Date(2030, 2, 4, 12, 0)).map(i => i.event.id)).toEqual(['adesso', 'pomeriggio']);
    });
});

describe('reminderSentLabel', () => {
    const { reminderSentLabel } = fns([]);
    it('mostra l\'ora se inviato oggi, altrimenti anche la data', () => {
        expect(reminderSentLabel('2030-03-04T18:32:00', new Date(2030, 2, 4, 20))).toBe('✓ inviato alle 18:32');
        expect(reminderSentLabel('2030-03-03T09:05:00', new Date(2030, 2, 4, 20))).toBe('✓ inviato il 3 mar alle 09:05');
        expect(reminderSentLabel(null)).toBe('');
    });
});
