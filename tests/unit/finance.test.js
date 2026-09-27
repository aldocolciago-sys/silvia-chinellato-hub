import { describe, it, expect } from 'vitest';
import { loadFunctions } from '../support/app-source.js';

function financeFns(centers = []) {
    const appState = { centers, events: [], patients: [] };
    return { appState, ...loadFunctions(
        ['normalizeManualRevenue', 'normalizeTaxProfile', 'financeEuro', 'isFinancialClinicalEvent', 'isNonClinicalEvent', 'getEventCenter', 'isShiftEvent', 'isShiftCenter'],
        { appState }
    ) };
}

const nbsp = (s) => s.replace(/ /g, ' ');

describe('normalizeManualRevenue', () => {
    const { normalizeManualRevenue } = financeFns();
    it('converte importi e applica valori predefiniti', () => {
        expect(normalizeManualRevenue({ id: 'r1', amount: '120.50', date: '2030-01-10' })).toEqual({
            id: 'r1', amount: 120.5, date: '2030-01-10', category: 'Fatturato storico', description: ''
        });
    });
    it('gestisce input nullo', () => {
        expect(normalizeManualRevenue(null)).toEqual({ amount: 0, date: '', category: 'Fatturato storico', description: '' });
    });
    it('conserva i campi aggiuntivi', () => {
        expect(normalizeManualRevenue({ id: 'x', amount: 1, createdAt: 't' }).createdAt).toBe('t');
    });
});

describe('normalizeTaxProfile', () => {
    const { normalizeTaxProfile } = financeFns();
    it('applica i valori predefiniti del regime forfettario', () => {
        expect(normalizeTaxProfile()).toEqual({
            id: 'default', previousYearRevenue: 0, profitabilityCoefficient: 78,
            substituteTaxRate: 15, inpsRate: 26.07, advanceRate: 100, updatedAt: null
        });
    });
    it('converte stringhe numeriche', () => {
        const p = normalizeTaxProfile({ previousYearRevenue: '25000', profitabilityCoefficient: '67', substituteTaxRate: '5', inpsRate: '24', advanceRate: '0', updatedAt: 'x' });
        expect(p).toMatchObject({ previousYearRevenue: 25000, profitabilityCoefficient: 67, substituteTaxRate: 5, inpsRate: 24, updatedAt: 'x' });
    });
    it('mantiene un acconto dello 0% (usa ?? e non ||)', () => {
        expect(normalizeTaxProfile({ advanceRate: 0 }).advanceRate).toBe(0);
    });
    it('ricade sul 78% se il coefficiente è 0 (comportamento attuale di ||)', () => {
        expect(normalizeTaxProfile({ profitabilityCoefficient: 0 }).profitabilityCoefficient).toBe(78);
    });
});

describe('financeEuro', () => {
    const { financeEuro } = financeFns();
    it.each([
        [0, '0,00 €'],
        [1234.5, '1234,50 €'], // in it-IT le cifre si raggruppano da 5 in su
        [12345.5, '12.345,50 €'],
        ['99.999', '100,00 €'],
        [null, '0,00 €'],
        [undefined, '0,00 €'],
        [-10, '-10,00 €']
    ])('%j → %s', (value, expected) => {
        expect(nbsp(financeEuro(value))).toBe(expected);
    });
});

describe('isFinancialClinicalEvent', () => {
    const centers = [
        { id: 'c1', name: 'Clinico', includeInFinance: true },
        { id: 'c2', name: 'Escluso', includeInFinance: false },
        { id: 'c3', name: 'Personale', isNonClinicalCalendar: true },
        { id: 'c4', name: 'Medicina dello Sport', isNonClinicalCalendar: true, isShiftCalendar: true, hourlyRate: 25, includeInFinance: false }
    ];
    const { isFinancialClinicalEvent } = financeFns(centers);

    it.each([
        ['evento dello studio privato', { extendedProps: {} }, true],
        ['evento in una sede inclusa', { extendedProps: { centerId: 'c1' } }, true],
        ['evento con sede sconosciuta', { extendedProps: { centerId: 'zzz' } }, true],
        ['evento in sede esclusa dal fatturato', { extendedProps: { centerId: 'c2' } }, false],
        ['evento di calendario non clinico', { extendedProps: { centerId: 'c3' } }, false],
        ['evento marcato non clinico', { extendedProps: { isNonClinical: true } }, false],
        ['evento annullato', { extendedProps: { paymentStatus: 'cancelled' } }, false],
        ['turno retribuito', { extendedProps: { centerId: 'c4' } }, true],
        ['turno annullato', { extendedProps: { centerId: 'c4', paymentStatus: 'cancelled' } }, false],
        ['evento nullo', null, false]
    ])('%s → %s', (_label, ev, expected) => {
        expect(isFinancialClinicalEvent(ev)).toBe(expected);
    });

    it('confronta gli ID sede come stringhe', () => {
        const { isFinancialClinicalEvent: check } = financeFns([{ id: 2, includeInFinance: false }]);
        expect(check({ extendedProps: { centerId: '2' } })).toBe(false);
    });
});
