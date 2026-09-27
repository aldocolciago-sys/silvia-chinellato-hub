import { describe, it, expect } from 'vitest';
import { loadFunctions, constSource } from '../support/app-source.js';

const { assessmentStatus, assessmentStatusLabel } = loadFunctions(['assessmentStatus', 'assessmentStatusLabel'], {}, { consts: ['ASSESSMENT_CHECKLISTS'] });
// eslint-disable-next-line no-new-func
const ASSESSMENT_CHECKLISTS = new Function(`${constSource('ASSESSMENT_CHECKLISTS')}\nreturn ASSESSMENT_CHECKLISTS;`)();

const allAnswers = (treatment, answer = 'no', overrides = {}) => Object.fromEntries(
    ASSESSMENT_CHECKLISTS[treatment].items.map(item => [item.id, { answer: item.id in overrides ? overrides[item.id] : answer, note: '' }])
);

describe('liste di controllo', () => {
    it('contengono le voci concordate, con id univoci', () => {
        expect(ASSESSMENT_CHECKLISTS.idrocolonterapia.items).toHaveLength(11);
        expect(ASSESSMENT_CHECKLISTS.osteopatia.items).toHaveLength(9);
        for (const list of Object.values(ASSESSMENT_CHECKLISTS)) {
            expect(new Set(list.items.map(i => i.id)).size).toBe(list.items.length);
        }
        expect(ASSESSMENT_CHECKLISTS.idrocolonterapia.items[0].label).toBe('Gravidanza o sospetta gravidanza');
        expect(ASSESSMENT_CHECKLISTS.osteopatia.items.at(-1).label).toBe('Storia di tumore');
    });
});

describe('assessmentStatus', () => {
    it('mancante se il paziente non ha la valutazione per quel trattamento', () => {
        expect(assessmentStatus({}, 'idrocolonterapia').status).toBe('missing');
        expect(assessmentStatus({ assessments: { osteopatia: null } }, 'osteopatia').status).toBe('missing');
        expect(assessmentStatus(null, 'osteopatia').status).toBe('missing');
    });

    it('ok se tutte le voci sono "no"', () => {
        const patient = { assessments: { idrocolonterapia: { date: '2030-03-01', verified: true, items: allAnswers('idrocolonterapia') } } };
        expect(assessmentStatus(patient, 'idrocolonterapia')).toEqual({ status: 'ok', flagged: [], missing: [], date: '2030-03-01', verified: true });
        expect(assessmentStatus(patient, 'osteopatia').status).toBe('missing'); // le valutazioni sono separate
    });

    it('da verificare se almeno una voce è "sì" (prevale sulle voci mancanti)', () => {
        const items = allAnswers('idrocolonterapia', 'no', { gravidanza: 'yes', diverticolite: 'yes', anemia: null });
        const result = assessmentStatus({ assessments: { idrocolonterapia: { items } } }, 'idrocolonterapia');
        expect(result.status).toBe('flagged');
        expect(result.flagged).toEqual(['Gravidanza o sospetta gravidanza', 'Diverticolite in corso']);
        expect(assessmentStatusLabel(result)).toBe('2 da verificare');
    });

    it('incompleta se mancano risposte', () => {
        const items = allAnswers('osteopatia', 'no', { trauma: null, tumore: null });
        const result = assessmentStatus({ assessments: { osteopatia: { items } } }, 'osteopatia');
        expect(result.status).toBe('incomplete');
        expect(assessmentStatusLabel(result)).toBe('Incompleta (2 voci)');
    });

    it('etichette', () => {
        expect(assessmentStatusLabel({ status: 'missing' })).toBe('Da compilare');
        expect(assessmentStatusLabel({ status: 'ok' })).toBe('Nessuna controindicazione');
    });
});
