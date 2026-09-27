import { describe, it, expect, vi, afterEach } from 'vitest';
import { loadFunctions } from '../support/app-source.js';

function whatsappFns(state = {}) {
    const appState = { centers: [], events: [], patients: [], ...state };
    return loadFunctions(
        ['normalizeWhatsAppNumber', 'buildWhatsAppUrl', 'isValidReviewUrl', 'detectTreatmentInText', 'suggestPatientTreatment',
            'buildPatientMessage', 'nextAppointmentContext', 'messageTypeLabel', 'lastContactLabel',
            'getPatientRecallStatus', 'isNonClinicalEvent', 'getEventCenter', 'normalizePersonName'],
        { appState },
        { consts: ['MESSAGE_TREATMENT_LABELS', 'WHATSAPP_MESSAGE_TYPES', 'WHATSAPP_TEMPLATES'] }
    );
}

describe('normalizeWhatsAppNumber', () => {
    const { normalizeWhatsAppNumber } = whatsappFns();
    it.each([
        ['333 1234567', '393331234567'],
        ['333-123-4567', '393331234567'],
        ['+39 333 1234567', '393331234567'],
        ['0039 333 1234567', '393331234567'],
        ['39 333 1234567', '393331234567'],
        ['02 1234567', '39021234567'],
        ['+41 79 123 45 67', '41791234567'],
        ['+44 7700 900123', '447700900123']
    ])('%s → %s', (input, expected) => {
        expect(normalizeWhatsAppNumber(input)).toBe(expected);
    });
    it.each([undefined, null, '', 'nessuno', '12345', '+1234567890123456'])('rifiuta %s', (input) => {
        expect(normalizeWhatsAppNumber(input)).toBe('');
    });
});

describe('buildWhatsAppUrl', () => {
    const { buildWhatsAppUrl } = whatsappFns();
    it('codifica il testo nel parametro text', () => {
        const url = new URL(buildWhatsAppUrl('333 1234567', 'Gentile Anna, è tutto ok? 50% & più'));
        expect(url.origin + url.pathname).toBe('https://wa.me/393331234567');
        expect(url.searchParams.get('text')).toBe('Gentile Anna, è tutto ok? 50% & più');
    });
    it('senza testo apre solo la chat', () => {
        expect(buildWhatsAppUrl('3331234567')).toBe('https://wa.me/393331234567');
    });
    it('restituisce stringa vuota con numero non valido', () => {
        expect(buildWhatsAppUrl('', 'x')).toBe('');
    });
});

describe('isValidReviewUrl', () => {
    const { isValidReviewUrl } = whatsappFns();
    it.each(['https://g.page/r/abc/review', 'https://search.google.com/local/writereview?placeid=X'])('accetta %s', (u) => expect(isValidReviewUrl(u)).toBe(true));
    it.each(['http://g.page/r/abc', 'javascript:alert(1)', 'g.page/r/abc', '', null, 'https://x.it/" onmouseover="1'])('rifiuta %s', (u) => expect(isValidReviewUrl(u)).toBe(false));
});

describe('suggestPatientTreatment', () => {
    afterEach(() => vi.useRealTimers());
    const now = new Date('2030-06-15T12:00:00Z');
    const patient = { id: 'p1', name: 'Anna' };

    it('usa il titolo dell’ultimo appuntamento', () => {
        vi.useFakeTimers(); vi.setSystemTime(now);
        const { suggestPatientTreatment } = whatsappFns({ events: [
            { id: 'a', title: 'Seduta idrocolonterapia', start: '2030-05-01T09:00:00', extendedProps: { patientId: 'p1' } },
            { id: 'b', title: 'Osteopatia', start: '2030-01-01T09:00:00', extendedProps: { patientId: 'p1' } }
        ] });
        const s = suggestPatientTreatment(patient);
        expect(s.treatment).toBe('idrocolonterapia');
        expect(s.reason).toBe('appointment');
        expect(s.date.getMonth()).toBe(4);
    });

    it('usa il servizio della sede se il titolo non indica il trattamento', () => {
        vi.useFakeTimers(); vi.setSystemTime(now);
        const { suggestPatientTreatment } = whatsappFns({
            centers: [{ id: 'c1', name: 'Poliambulatorio San Benedetto', service: 'Idrocolonterapia' }],
            events: [{ id: 'a', title: 'Visita / Trattamento - Anna', start: '2030-05-01T09:00:00', extendedProps: { patientId: 'p1', centerId: 'c1', centerName: 'Poliambulatorio San Benedetto' } }]
        });
        expect(suggestPatientTreatment(patient).treatment).toBe('idrocolonterapia');
    });

    it('usa il prossimo appuntamento se non ci sono visite passate', () => {
        vi.useFakeTimers(); vi.setSystemTime(now);
        const { suggestPatientTreatment } = whatsappFns({ events: [
            { id: 'a', title: 'Osteopatia cervicale', start: '2030-07-01T09:00:00', extendedProps: { patientId: 'p1' } }
        ] });
        expect(suggestPatientTreatment(patient)).toMatchObject({ treatment: 'osteopatia', reason: 'appointment' });
    });

    it('ricade sui tag del paziente', () => {
        const { suggestPatientTreatment } = whatsappFns();
        expect(suggestPatientTreatment({ id: 'x', tags: ['colon irritabile'] })).toMatchObject({ treatment: 'idrocolonterapia', reason: 'tags' });
    });

    it('senza indizi propone osteopatia senza motivazione', () => {
        const { suggestPatientTreatment } = whatsappFns();
        expect(suggestPatientTreatment({ id: 'x' })).toEqual({ treatment: 'osteopatia', date: null, reason: null });
    });
});

describe('buildPatientMessage', () => {
    const fns = whatsappFns();
    const patient = { name: 'Mario Rossi' };
    const context = { reviewUrl: 'https://g.page/r/abc/review', date: 'martedì 15 gennaio', time: '09:30', place: 'Centro Polisalute' };
    const types = ['news', 'appointment', 'review', 'thanks', 'reminder'];

    for (const treatment of ['osteopatia', 'idrocolonterapia']) {
        for (const type of types) {
            it(`${treatment} / ${type}: testo formale completo senza segnaposto`, () => {
                const text = fns.buildPatientMessage(type, treatment, patient, context);
                expect(text.startsWith('Gentile Mario Rossi,')).toBe(true);
                expect(text).not.toMatch(/\{\w+\}/);
                expect(text).not.toMatch(/\b(ti|tuo|tua|stai)\b/i); // tono formale ("Lei")
                expect(text).toMatch(treatment === 'osteopatia' ? /osteopat|visita di oggi/i : /idrocolon|alimentazione/i);
            });
        }
    }

    it('inserisce il link nella richiesta di recensione', () => {
        expect(fns.buildPatientMessage('review', 'osteopatia', patient, context)).toContain('Può farlo qui: https://g.page/r/abc/review.');
    });

    it('inserisce data, ora e sede nel promemoria', () => {
        expect(fns.buildPatientMessage('reminder', 'idrocolonterapia', patient, context)).toContain('seduta di idrocolonterapia di martedì 15 gennaio alle 09:30 presso Centro Polisalute');
    });

    it('usa "lo studio" se la sede non è indicata e "paziente" se manca il nome', () => {
        const text = fns.buildPatientMessage('reminder', 'osteopatia', {}, { date: 'lunedì 1 luglio', time: '10:00' });
        expect(text.startsWith('Gentile paziente,')).toBe(true);
        expect(text).toContain('presso lo studio');
    });

    it('restituisce stringa vuota per tipi o trattamenti sconosciuti', () => {
        expect(fns.buildPatientMessage('boh', 'osteopatia', patient)).toBe('');
        expect(fns.buildPatientMessage('news', 'boh', patient)).toBe('');
    });
});

describe('lastContactLabel', () => {
    const { lastContactLabel } = whatsappFns();
    it('descrive data, tipo e trattamento', () => {
        expect(lastContactLabel({ lastContactAt: '2030-03-12T09:30:00.000Z', lastContactType: 'review', lastContactTreatment: 'osteopatia' }))
            .toBe('12 mar 2030, 10:30 – Recensione Google (Osteopatia)');
    });
    it('è vuoto senza contatti o con data non valida', () => {
        expect(lastContactLabel({})).toBe('');
        expect(lastContactLabel({ lastContactAt: 'boh' })).toBe('');
    });
});
