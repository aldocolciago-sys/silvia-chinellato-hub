import { describe, it, expect, afterEach } from 'vitest';
import { bootApp, SHARED, PUBLIC, APP_ID, AUTHORIZED_EMAIL } from '../support/jsdom-app.js';
import { seedDocs, center, patient, studioEvent, MIGRATION_MARKERS } from '../fixtures/seed.js';

let app;
afterEach(() => app?.close());

const UID = `uid-${AUTHORIZED_EMAIL}`;
const LEGACY = `artifacts/${APP_ID}/users/${UID}`;

function withoutMarker(markerSuffix) {
    return Object.fromEntries(Object.entries(MIGRATION_MARKERS).filter(([k]) => !k.endsWith(markerSuffix)));
}

describe('migrazioni dati una-tantum', () => {
    it('copia i dati legacy dell’utente nell’area condivisa senza sovrascrivere', async () => {
        app = await bootApp({
            docs: {
                ...seedDocs({ skipMigrations: false, centers: [center({ id: 'c1' })], patients: [patient({ id: 'shared', name: 'Versione condivisa' })] }),
                ...withoutMarker(`legacy-migration-${UID}`),
                [`${LEGACY}/patients_list/legacy1`]: patient({ id: 'legacy1', name: 'Paziente legacy' }),
                [`${LEGACY}/patients_list/shared`]: patient({ id: 'shared', name: 'Versione legacy' }),
                [`${LEGACY}/studio_events/ev1`]: studioEvent({ id: 'ev1' })
            }
        });
        await app.login();
        expect(app.mock.get(`${SHARED}/patients_list/legacy1`).name).toBe('Paziente legacy');
        expect(app.mock.get(`${SHARED}/patients_list/shared`).name).toBe('Versione condivisa');
        expect(app.mock.has(`${SHARED}/studio_events/ev1`)).toBe(true);
        expect(app.mock.get(`${SHARED}/_meta/legacy-migration-${UID}`)).toMatchObject({ completed: true, userId: UID });
    });

    it('archivia le note cliniche presenti negli eventi', async () => {
        app = await bootApp({
            docs: {
                ...seedDocs({ skipMigrations: false, centers: [center()], events: [
                    studioEvent({ id: 'e1', extendedProps: { patientId: 'p1', clinicalNote: 'nota evento' } }),
                    studioEvent({ id: 'e2', extendedProps: { patientId: null, clinicalNote: 'senza paziente' } })
                ] }),
                ...withoutMarker('clinical-sessions-migration-v1')
            }
        });
        await app.login();
        expect(app.mock.get(`${SHARED}/clinical_sessions/e1`)).toMatchObject({ patientId: 'p1', clinicalNote: 'nota evento' });
        expect(app.mock.has(`${SHARED}/clinical_sessions/e2`)).toBe(false);
        expect(app.mock.get(`${SHARED}/_meta/clinical-sessions-migration-v1`).completed).toBe(true);
        expect(app.state.clinicalSessions.map(s => s.eventId)).toEqual(['e1']);
    });

    it('estrae i blocchi clinici legacy dalle note del paziente e ripulisce le note', async () => {
        const notes = 'Anamnesi generale\n[SEDUTA:old1]\nSeduta\nSede: Studio\nNota seduta: dolore spalla\nEsito: migliorato\n[/SEDUTA:old1]';
        app = await bootApp({
            docs: {
                ...seedDocs({ skipMigrations: false, centers: [center()], patients: [patient({ id: 'p1', notes })] }),
                ...withoutMarker('patient-notes-clinical-blocks-migration-v2')
            }
        });
        await app.login();
        expect(app.mock.get(`${SHARED}/patients_list/p1`).notes).toBe('Anamnesi generale');
        expect(app.mock.get(`${SHARED}/clinical_sessions/old1`)).toMatchObject({ patientId: 'p1', clinicalNote: 'dolore spalla', clinicalOutcome: 'migliorato', migratedFromPatientNotes: true });
        expect(app.mock.get(`${SHARED}/_meta/patient-notes-clinical-blocks-migration-v2`)).toMatchObject({ completed: true, migratedBlocks: 1, cleanedPatients: 1 });
    });

    it('non ripete le migrazioni già completate', async () => {
        const notes = '[SEDUTA:old1]\nNota seduta: x\n[/SEDUTA:old1]';
        app = await bootApp({ docs: seedDocs({ centers: [center()], patients: [patient({ id: 'p1', notes })] }) });
        await app.login();
        expect(app.mock.get(`${SHARED}/patients_list/p1`).notes).toBe(notes);
        expect(app.mock.has(`${SHARED}/clinical_sessions/old1`)).toBe(false);
    });

    it('completa i flag finanziari mancanti delle sedi e forza i calendari non clinici come privati', async () => {
        app = await bootApp({
            docs: seedDocs({ centers: [
                { id: 'legacy', name: 'Vecchia sede', service: 'Osteo' },
                { id: 'nc', name: 'Personale', service: '-', isNonClinicalCalendar: true, showPublic: true, includeInFinance: true }
            ] })
        });
        await app.login();
        expect(app.mock.get(`${SHARED}/centers_list/legacy`)).toMatchObject({ isNonClinicalCalendar: false, includeInFinance: true });
        expect(app.mock.get(`${PUBLIC}/centers_list/legacy`)).toMatchObject({ includeInFinance: true });
        expect(app.mock.get(`${SHARED}/centers_list/nc`)).toMatchObject({ showPublic: false, includeInFinance: false });
    });

    it('un errore durante le migrazioni non blocca l’area riservata', async () => {
        app = await bootApp({ docs: { ...seedDocs({ skipMigrations: false, centers: [center()] }) } });
        app.mock.failNext('getDocs', `${LEGACY}/centers_list`);
        await app.login();
        expect(app.isHidden('private-view')).toBe(false);
    });

    // KNOWN BUG: un errore in una migrazione interrompe tutto loadAllDataFromFirestore:
    // pazienti/appuntamenti non vengono caricati e la sincronizzazione realtime non parte.
    it.fails('carica comunque i dati condivisi se una migrazione fallisce', async () => {
        app = await bootApp({ docs: seedDocs({ skipMigrations: false, centers: [center()], patients: [patient({ id: 'p1' })] }) });
        app.mock.failNext('getDocs', `${LEGACY}/centers_list`);
        await app.login();
        expect(app.state.patients.map(p => p.id)).toEqual(['p1']);
    });
});
