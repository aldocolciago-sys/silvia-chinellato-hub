import { describe, it, expect } from 'vitest';
import { loadFunctions } from '../support/app-source.js';

function rateFns(state = {}) {
    const appState = { centers: [], events: [], patients: [], financeSettings: null, ...state };
    return loadFunctions(
        ['defaultFeeForEvent', 'eventTreatment', 'ratesForCenter', 'eventDurationHours', 'roundEuro', 'isShiftCenter', 'isShiftEvent',
            'isNonClinicalEvent', 'getEventCenter', 'detectTreatmentInText', 'normalizePersonName'],
        { appState }
    );
}

const centers = [
    { id: 'cms', name: 'CMS - Carate Brianza', service: 'Idrocolonterapia', rateIdrocolonterapia: 40, rateOsteopatia: 0 },
    { id: 'misto', name: 'Centro Misto', service: 'Visite', rateIdrocolonterapia: 40, rateOsteopatia: 55 },
    { id: 'sport', name: 'Medicina dello Sport', isNonClinicalCalendar: true, isShiftCalendar: true, hourlyRate: 25 },
    { id: 'casa', name: 'Agenda personale', isNonClinicalCalendar: true }
];
const ev = (centerId, title = 'Visita', start = '2030-01-15T09:00:00', end = '2030-01-15T10:00:00') => ({ title, start, end, extendedProps: { centerId } });

describe('eventDurationHours', () => {
    const { eventDurationHours } = rateFns();
    it.each([
        ['2030-01-15T08:00:00', '2030-01-15T13:00:00', 5],
        ['2030-01-15T08:00:00', '2030-01-15T08:30:00', 0.5],
        ['2030-01-15T22:00:00', '2030-01-16T06:00:00', 8],
        ['2030-01-15T10:00:00', '2030-01-15T09:00:00', 0],
        ['2030-01-15T10:00:00', null, 0],
        ['boh', '2030-01-15T10:00:00', 0]
    ])('%s → %s = %s ore', (start, end, hours) => {
        expect(eventDurationHours({ start, end })).toBe(hours);
    });
});

describe('defaultFeeForEvent', () => {
    it('usa la tariffa del trattamento riconosciuto dalla sede', () => {
        const { defaultFeeForEvent } = rateFns({ centers });
        expect(defaultFeeForEvent(ev('cms', 'Marco Colombo'))).toBe(40);
    });

    it('distingue i trattamenti dal titolo in una sede con più tariffe', () => {
        const { defaultFeeForEvent } = rateFns({ centers });
        expect(defaultFeeForEvent(ev('misto', 'Osteopatia - Anna'))).toBe(55);
        expect(defaultFeeForEvent(ev('misto', 'Idrocolonterapia - Anna'))).toBe(40);
        expect(defaultFeeForEvent(ev('misto', 'Anna Rossi'))).toBe(0); // trattamento ambiguo e tariffe diverse
    });

    it('usa l’unica tariffa della sede se il trattamento non si capisce', () => {
        const { defaultFeeForEvent } = rateFns({ centers: [{ id: 'x', name: 'Centro', service: 'Visite', rateIdrocolonterapia: 45 }] });
        expect(defaultFeeForEvent(ev('x', 'Paziente'))).toBe(45);
    });

    it('calcola i turni come durata × tariffa oraria', () => {
        const { defaultFeeForEvent } = rateFns({ centers });
        expect(defaultFeeForEvent(ev('sport', 'Turno', '2030-01-15T08:00:00', '2030-01-15T13:30:00'))).toBe(137.5);
    });

    it('vale zero per i calendari personali', () => {
        const { defaultFeeForEvent } = rateFns({ centers });
        expect(defaultFeeForEvent(ev('casa', 'Dentista'))).toBe(0);
    });

    it('usa le tariffe dello studio privato per gli appuntamenti senza sede', () => {
        const { defaultFeeForEvent } = rateFns({ centers, financeSettings: { privateRates: { osteopatia: 60, idrocolonterapia: 0 } } });
        expect(defaultFeeForEvent(ev(null, 'Visita / Trattamento - Giulia'))).toBe(60);
    });

    it('vale zero senza tariffe impostate', () => {
        const { defaultFeeForEvent } = rateFns();
        expect(defaultFeeForEvent(ev(null, 'Osteopatia'))).toBe(0);
    });
});

describe('isShiftCenter', () => {
    const { isShiftCenter } = rateFns();
    it('richiede calendario non clinico e opzione turni', () => {
        expect(isShiftCenter({ isNonClinicalCalendar: true, isShiftCalendar: true })).toBe(true);
        expect(isShiftCenter({ isNonClinicalCalendar: false, isShiftCalendar: true })).toBe(false);
        expect(isShiftCenter({ isNonClinicalCalendar: true })).toBe(false);
        expect(isShiftCenter(null)).toBe(false);
    });
});
