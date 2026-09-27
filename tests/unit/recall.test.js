import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadFunctions } from '../support/app-source.js';

function recallFns(state) {
    const appState = { centers: [], events: [], patients: [], ...state };
    return loadFunctions(
        ['buildRecallWhatsAppUrl', 'buildRecallEmailUrl', 'getPatientRecallStatus', 'isNonClinicalEvent', 'getEventCenter'],
        { appState }
    );
}

describe('buildRecallWhatsAppUrl', () => {
    const { buildRecallWhatsAppUrl } = recallFns();
    it('usa solo le cifre del numero e codifica il messaggio', () => {
        const url = buildRecallWhatsAppUrl({ name: 'Anna', phone: '+39 333-123 4567' });
        expect(url.startsWith('https://wa.me/393331234567?text=')).toBe(true);
        expect(decodeURIComponent(url.split('text=')[1])).toBe('Ciao Anna, ti contatto dallo studio per sapere come stai e, se desideri, organizzare il prossimo appuntamento.');
    });
    it.each([undefined, '', 'nessuno'])('restituisce stringa vuota senza cifre (%s)', (phone) => {
        expect(buildRecallWhatsAppUrl({ name: 'Anna', phone })).toBe('');
    });
});

describe('buildRecallEmailUrl', () => {
    const { buildRecallEmailUrl } = recallFns();
    it('crea un link mailto con oggetto e corpo codificati', () => {
        const url = new URL(buildRecallEmailUrl({ name: 'Anna', email: ' anna@example.com ' }));
        expect(url.protocol).toBe('mailto:');
        expect(url.pathname).toBe('anna@example.com');
        expect(url.searchParams.get('subject')).toBe('Richiamo per il prossimo appuntamento');
        expect(url.searchParams.get('body')).toContain('Ciao Anna,\n\n');
    });
    it('restituisce stringa vuota senza email', () => {
        expect(buildRecallEmailUrl({ name: 'Anna', email: '   ' })).toBe('');
    });
});

describe('getPatientRecallStatus', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2030-06-15T12:00:00Z'));
    });
    afterEach(() => vi.useRealTimers());

    const events = [
        { id: 'old', start: '2030-01-10T09:00:00', extendedProps: { patientId: 'p1' } },
        { id: 'recent', start: '2030-05-01T09:00:00', extendedProps: { patientId: 'p1' } },
        { id: 'future-far', start: '2030-09-01T09:00:00', extendedProps: { patientId: 'p1' } },
        { id: 'future-near', start: '2030-07-01T09:00:00', extendedProps: { patientId: 'p1' } },
        { id: 'cancelled', start: '2030-06-01T09:00:00', extendedProps: { patientId: 'p1', paymentStatus: 'cancelled' } },
        { id: 'non-clinical', start: '2030-06-10T09:00:00', extendedProps: { patientId: 'p1', isNonClinical: true } },
        { id: 'other', start: '2030-06-14T09:00:00', extendedProps: { patientId: 'p2' } },
        { id: 'invalid', start: 'boh', extendedProps: { patientId: 'p1' } }
    ];

    it('individua ultima visita passata e prossimo appuntamento', () => {
        const { getPatientRecallStatus } = recallFns({ events });
        const status = getPatientRecallStatus({ id: 'p1' });
        expect(status.lastVisit.event.id).toBe('recent');
        expect(status.nextAppointment.event.id).toBe('future-near');
    });

    it('ignora appuntamenti annullati, non clinici, di altri pazienti o con data non valida', () => {
        const { getPatientRecallStatus } = recallFns({ events: events.filter(e => ['cancelled', 'non-clinical', 'other', 'invalid'].includes(e.id)) });
        expect(getPatientRecallStatus({ id: 'p1' })).toEqual({ lastVisit: null, nextAppointment: null });
    });

    it('confronta gli ID paziente come stringhe', () => {
        const { getPatientRecallStatus } = recallFns({ events: [{ id: 'n', start: '2030-01-01T09:00:00', extendedProps: { patientId: 7 } }] });
        expect(getPatientRecallStatus({ id: '7' }).lastVisit.event.id).toBe('n');
    });
});
