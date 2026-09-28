import { describe, it, expect } from 'vitest';
import { loadFunctions } from '../support/app-source.js';

const fns = loadFunctions(
    ['buildTaxSchedule', 'estimateTaxLiability', 'taxAdvancePlan', 'businessDayOnOrAfter', 'localDayKey', 'roundEuro', 'parseDayMonth', 'groupTaxSchedule', 'normalizeTaxProfile'],
    {},
    { consts: ['TAX_ADVANCE_MIN', 'TAX_ADVANCE_SINGLE_MAX'] }
);
const { buildTaxSchedule, estimateTaxLiability, taxAdvancePlan, businessDayOnOrAfter, groupTaxSchedule, normalizeTaxProfile } = fns;
const profile = (extra = {}) => normalizeTaxProfile({ profitabilityCoefficient: 78, substituteTaxRate: 5, inpsRate: 26.07, ...extra });

describe('estimateTaxLiability', () => {
    it('reddito forfettario, contributi e imposta sulla base al netto dei contributi', () => {
        // 30.000 × 78% = 23.400; contributi 26,07% = 6.100,38; imposta 5% di 17.299,62 = 864,98
        expect(estimateTaxLiability(30000, profile())).toEqual({ contributions: 6100.38, substituteTax: 864.98 });
    });
});

describe('taxAdvancePlan', () => {
    it.each([
        [0, { first: 0, second: 0 }],
        [51.65, { first: 0, second: 0 }],
        [51.66, { first: 0, second: 51.66 }],
        [257.52, { first: 0, second: 257.52 }],
        [1000, { first: 400, second: 600 }]
    ])('imposta %s → %o', (tax, plan) => {
        expect(taxAdvancePlan(tax)).toEqual(plan);
    });
});

describe('businessDayOnOrAfter', () => {
    it('sposta sabato e domenica al lunedì', () => {
        expect(businessDayOnOrAfter(2029, 6, 30)).toBe('2029-07-02'); // sabato
        expect(businessDayOnOrAfter(2030, 6, 30)).toBe('2030-07-01'); // domenica
        expect(businessDayOnOrAfter(2031, 6, 30)).toBe('2031-06-30'); // lunedì
        expect(businessDayOnOrAfter(2030, 11, 30)).toBe('2030-12-02'); // sabato
    });
});

describe('buildTaxSchedule – Gestione separata', () => {
    it('giugno: saldo e 1° acconto di imposta e contributi; novembre: 2° acconto', () => {
        const schedule = buildTaxSchedule(2031, profile(), { 2029: 20000, 2030: 30000 });
        // 2029: contributi 4.066,92; imposta 576,65 → acconti imposta 2030 230,66 + 345,99; contributi 80% = 3.253,54
        expect(schedule.advancesKnown).toBe(true);
        expect(schedule.items).toEqual([
            { date: '2031-06-30', kind: 'tax', label: 'Saldo imposta sostitutiva 2030', amount: 288.33 },
            { date: '2031-06-30', kind: 'tax', label: '1° acconto imposta sostitutiva 2031 (40%)', amount: 345.99 },
            { date: '2031-06-30', kind: 'contributions', label: 'Saldo contributi Gestione separata 2030', amount: 2846.84 },
            { date: '2031-06-30', kind: 'contributions', label: '1° acconto contributi 2031 (40%)', amount: 2440.15 },
            { date: '2031-12-01', kind: 'tax', label: '2° acconto imposta sostitutiva 2031 (60%)', amount: 518.99 },
            { date: '2031-12-01', kind: 'contributions', label: '2° acconto contributi 2031 (40%)', amount: 2440.15 }
        ]);
        const groups = groupTaxSchedule(schedule.items);
        expect(groups.map(g => [g.date, g.total])).toEqual([['2031-06-30', 5921.31], ['2031-12-01', 2959.14]]);
    });

    it('senza dati dell\'anno prima non conosce gli acconti versati', () => {
        const schedule = buildTaxSchedule(2031, profile(), { 2030: 30000 });
        expect(schedule.advancesKnown).toBe(false);
        expect(schedule.items[0]).toMatchObject({ label: 'Saldo imposta sostitutiva 2030', amount: 864.98 });
    });

    it('imposta piccola: acconto unico a novembre', () => {
        const schedule = buildTaxSchedule(2031, profile(), { 2030: 5000 }); // imposta 144,16
        const taxItems = schedule.items.filter(i => i.kind === 'tax');
        expect(taxItems.map(i => [i.date, i.label, i.amount])).toEqual([
            ['2031-06-30', 'Saldo imposta sostitutiva 2030', 144.16],
            ['2031-12-01', 'Acconto unico imposta sostitutiva 2031', 144.16]
        ]);
    });

    it('nessun fatturato dell\'anno precedente', () => {
        expect(buildTaxSchedule(2031, profile(), {})).toEqual({ items: [], advancesKnown: false, missingRevenue: 2030 });
    });
});

describe('buildTaxSchedule – cassa con date personalizzate', () => {
    it('usa le date e le percentuali indicate sui contributi dell\'anno precedente', () => {
        const p = profile({ pensionFund: 'custom', customDeadlines: [{ label: 'Saldo ENPAPI', day: '30/09', percent: 100 }] });
        const schedule = buildTaxSchedule(2030, p, { 2029: 30000 });
        expect(schedule.items.filter(i => i.kind === 'contributions')).toEqual([
            { date: '2030-09-30', kind: 'contributions', label: 'Saldo ENPAPI', amount: 6100.38 }
        ]);
        expect(schedule.items.some(i => i.label.includes('Gestione separata'))).toBe(false);
    });
});
