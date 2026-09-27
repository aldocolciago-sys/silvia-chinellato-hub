import { describe, it, expect } from 'vitest';
import { loadFunctions } from '../support/app-source.js';

const { validateBackupPayload, backupCounts } = loadFunctions(
    ['validateBackupPayload', 'backupCounts'], {}, { consts: ['BACKUP_SCHEMA', 'BACKUP_SCHEMA_VERSION'] }
);

export function makeBackup(overrides = {}) {
    return {
        schema: 'silvia-chinellato-backup',
        schemaVersion: 1,
        appBuild: 'v31',
        createdAt: '2030-01-01T10:00:00.000Z',
        data: {
            patients: [{ id: 'p1', name: 'Mario' }],
            events: [{ id: 'e1', title: 'Visita' }],
            clinicalSessions: [{ eventId: 'e1', patientId: 'p1' }],
            centers: [{ id: 'c1', name: 'Centro' }],
            treatments: [{ id: 't1' }],
            news: [{ id: 'n1' }],
            preparations: [{ id: 'pr1' }],
            manualRevenues: [{ id: 'r1', amount: 10 }],
            taxProfile: { previousYearRevenue: 1000 },
            ...overrides
        }
    };
}

describe('backupCounts', () => {
    it('conta ogni sezione del backup', () => {
        expect(backupCounts(makeBackup().data)).toEqual({
            patients: 1, events: 1, clinicalSessions: 1, centers: 1, treatments: 1,
            news: 1, preparations: 1, manualRevenues: 1, taxProfiles: 1
        });
    });
    it('restituisce zero per sezioni mancanti o non array', () => {
        expect(backupCounts({ patients: 'x', taxProfile: null })).toEqual({
            patients: 0, events: 0, clinicalSessions: 0, centers: 0, treatments: 0,
            news: 0, preparations: 0, manualRevenues: 0, taxProfiles: 0
        });
        expect(backupCounts(undefined).patients).toBe(0);
    });
});

describe('validateBackupPayload', () => {
    it('accetta un backup completo e valido', () => {
        const payload = makeBackup();
        expect(validateBackupPayload(payload)).toBe(payload);
    });

    it('accetta backup precedenti privi di manualRevenues e taxProfile e li inizializza', () => {
        const payload = makeBackup();
        delete payload.data.manualRevenues;
        delete payload.data.taxProfile;
        const result = validateBackupPayload(payload);
        expect(result.data.manualRevenues).toEqual([]);
        expect(result.data.taxProfile).toBeNull();
    });

    it('accetta schemaVersion come stringa numerica', () => {
        expect(() => validateBackupPayload({ ...makeBackup(), schemaVersion: '1' })).not.toThrow();
    });

    it.each([
        ['payload nullo', null],
        ['schema errato', { ...makeBackup(), schema: 'altro' }],
        ['versione futura', { ...makeBackup(), schemaVersion: 2 }],
        ['sezione data assente', { schema: 'silvia-chinellato-backup', schemaVersion: 1 }]
    ])('rifiuta %s', (_label, payload) => {
        expect(() => validateBackupPayload(payload)).toThrow('Formato backup non riconosciuto.');
    });

    it.each(['patients', 'events', 'clinicalSessions', 'centers', 'treatments', 'news', 'preparations'])(
        'rifiuta la sezione obbligatoria %s mancante',
        (key) => {
            const payload = makeBackup();
            delete payload.data[key];
            expect(() => validateBackupPayload(payload)).toThrow(`Sezione ${key} mancante o non valida.`);
        }
    );

    it('rifiuta manualRevenues non array', () => {
        expect(() => validateBackupPayload(makeBackup({ manualRevenues: {} }))).toThrow('Sezione manualRevenues non valida.');
    });

    it('rifiuta taxProfile non oggetto', () => {
        expect(() => validateBackupPayload(makeBackup({ taxProfile: 'x' }))).toThrow('Sezione taxProfile non valida.');
    });

    it.each(['patients', 'events', 'centers', 'manualRevenues'])('rifiuta record senza ID nella sezione %s', (key) => {
        expect(() => validateBackupPayload(makeBackup({ [key]: [{ name: 'senza id' }] }))).toThrow(`Record senza ID nella sezione ${key}.`);
    });

    it('rifiuta record nulli o con ID composto solo da spazi', () => {
        expect(() => validateBackupPayload(makeBackup({ news: [null] }))).toThrow('Record senza ID nella sezione news.');
        expect(() => validateBackupPayload(makeBackup({ news: [{ id: '   ' }] }))).toThrow('Record senza ID nella sezione news.');
    });

    it('accetta sedute cliniche identificate solo da eventId', () => {
        expect(() => validateBackupPayload(makeBackup({ clinicalSessions: [{ eventId: 'e9' }] }))).not.toThrow();
    });
});
