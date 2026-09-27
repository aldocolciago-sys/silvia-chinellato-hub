import { describe, it, expect } from 'vitest';
import { loadFunctions } from '../support/app-source.js';

const f = loadFunctions(['normalizePersonName', 'levenshteinSimilarity', 'patientMatchScore', 'duplicatePatientScore']);

describe('normalizePersonName', () => {
    it.each([
        ['Mario Rossi', 'mario rossi'],
        ['  Nicolò  D\'Amico-Rossi ', 'nicolo d amico rossi'],
        ['ÀÈÌÒÙ àèìòù', 'aeiou aeiou'],
        ['Visita / Trattamento - Anna', 'visita trattamento anna'],
        ['', ''],
        [null, ''],
        [undefined, '']
    ])('%j → %j', (input, expected) => {
        expect(f.normalizePersonName(input)).toBe(expected);
    });
});

describe('levenshteinSimilarity', () => {
    it('vale 1 per nomi identici (anche con accenti/maiuscole diverse)', () => {
        expect(f.levenshteinSimilarity('Nicolò Bianchi', 'nicolo bianchi')).toBe(1);
    });
    it('è alta per un refuso di un carattere', () => {
        expect(f.levenshteinSimilarity('Mario Rossi', 'Mario Rosi')).toBeCloseTo(10 / 11, 5);
    });
    it('vale 0 per stringhe completamente diverse della stessa lunghezza', () => {
        expect(f.levenshteinSimilarity('abc', 'xyz')).toBe(0);
    });
    it('vale 0 se uno dei due valori è vuoto', () => {
        expect(f.levenshteinSimilarity('', 'Mario')).toBe(0);
        expect(f.levenshteinSimilarity('Mario', null)).toBe(0);
    });
    it('è simmetrica', () => {
        expect(f.levenshteinSimilarity('Giulia', 'Giuliana')).toBe(f.levenshteinSimilarity('Giuliana', 'Giulia'));
    });
});

describe('patientMatchScore', () => {
    it('vale 1 se il titolo contiene il nome completo', () => {
        expect(f.patientMatchScore('Visita - Mario Rossi', 'Mario Rossi')).toBe(1);
    });
    it('vale 1 se tutti i token del nome compaiono in ordine diverso', () => {
        expect(f.patientMatchScore('Rossi Mario osteopatia', 'Mario Rossi')).toBe(1);
    });
    it('vale 0.5 se compare solo il cognome', () => {
        expect(f.patientMatchScore('Rossi', 'Mario Rossi')).toBe(0.5);
    });
    it('resta sotto la soglia di suggerimento (0.35) per titoli non correlati', () => {
        expect(f.patientMatchScore('Riunione', 'Mario Rossi')).toBeLessThan(0.35);
    });
    it('ignora i token di un solo carattere', () => {
        expect(f.patientMatchScore('Appuntamento con X', 'X')).toBe(1); // contiene il nome intero
        expect(f.patientMatchScore('Zzzz', 'A B')).toBe(0);
    });
    it('vale 0 per input vuoti', () => {
        expect(f.patientMatchScore('', 'Mario')).toBe(0);
        expect(f.patientMatchScore('Mario', '')).toBe(0);
    });
});

describe('duplicatePatientScore', () => {
    it('vale 1 per telefono identico dopo la normalizzazione delle cifre', () => {
        expect(f.duplicatePatientScore({ name: 'Mario Rossi', phone: '333 111' }, { name: 'Luca Verdi', phone: '+333-111' })).toBe(1);
    });
    it('vale 1 per email identica senza distinzione di maiuscole', () => {
        expect(f.duplicatePatientScore({ name: 'Anna', email: 'A@x.it' }, { name: 'Bea', email: 'a@X.it' })).toBe(1);
    });
    it('usa la somiglianza dei nomi in assenza di contatti', () => {
        expect(f.duplicatePatientScore({ name: 'Mario Rossi' }, { name: 'Mario Rosi' })).toBeGreaterThanOrEqual(0.55);
        expect(f.duplicatePatientScore({ name: 'Anna Bianchi' }, { name: 'Carlo Neri' })).toBeLessThan(0.55);
    });
    it('non considera duplicati due pazienti con telefono vuoto', () => {
        expect(f.duplicatePatientScore({ name: 'Anna Bianchi', phone: '' }, { name: 'Carlo Neri', phone: '' })).toBeLessThan(0.55);
    });
});
