import { describe, it, expect, afterEach } from 'vitest';
import { bootApp, SHARED, PUBLIC } from '../support/jsdom-app.js';
import { seedDocs, center, patient, studioEvent } from '../fixtures/seed.js';

let app;
afterEach(() => app?.close());

async function loggedIn(data = {}) {
    let lastBlob = null;
    app = await bootApp({
        docs: seedDocs({ centers: [center({ id: 'c1' })], ...data }),
        beforeScript: (w) => { w.URL.createObjectURL = (blob) => { lastBlob = blob; return 'blob:backup'; }; }
    });
    await app.login();
    app.window.closeSyncReportModal();
    return { lastBlob: () => lastBlob };
}

/** Legge un Blob jsdom (che non implementa .text()) tramite FileReader. */
function readBlob(blob) {
    return new Promise((resolve, reject) => {
        const reader = new app.window.FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsText(blob);
    });
}

function backupFile(payload, size) {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return { size: size ?? text.length, text: async () => text };
}

async function analyze(file) {
    await app.window.analyzeBackupFile({ target: { files: [file] } });
    await app.flush();
}

const validBackup = () => ({
    schema: 'silvia-chinellato-backup',
    schemaVersion: 1,
    createdAt: '2030-01-01T10:00:00.000Z',
    data: {
        patients: [patient({ id: 'rp1', name: 'Ripristinato' })],
        events: [studioEvent({ id: 're1' })],
        clinicalSessions: [{ eventId: 're1', patientId: 'rp1', clinicalNote: 'n' }],
        centers: [center({ id: 'rc1', name: 'Sede ripristinata' })],
        treatments: [{ id: 'rt1', title: 'T' }],
        news: [{ id: 'rn1', title: 'N' }],
        preparations: [{ id: 'rpr1', title: 'P' }],
        manualRevenues: [{ id: 'rr1', amount: 5, date: '2030-01-01' }],
        taxProfile: { previousYearRevenue: 1 }
    }
});

describe('backup completo', () => {
    it('mostra i conteggi nella dashboard backup', async () => {
        await loggedIn({ patients: [patient({ id: 'p1' }), patient({ id: 'p2' })], events: [studioEvent()] });
        app.window.openBackupModal();
        const values = app.$$('#backup-kpis strong').map(s => s.textContent);
        expect(values.slice(0, 3)).toEqual(['2', '1', '0']);
        expect(app.text('backup-last-export')).toBe('Nessun export registrato su questo dispositivo.');
        expect(app.byId('backup-restore-btn').disabled).toBe(true);
    });

    it('esporta un file JSON con schema, conteggi e tutti i dati', async () => {
        const { lastBlob } = await loggedIn({ patients: [patient({ id: 'p1' })], events: [studioEvent({ id: 'e1' })], manualRevenues: [{ id: 'r1', amount: 10, date: '2030-01-01' }] });
        let downloadName = null;
        app.window.HTMLAnchorElement.prototype.click = function () { downloadName = this.download; };
        app.window.openBackupModal();
        app.window.exportCompleteBackup();
        expect(downloadName).toMatch(/^backup_silvia_\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/);
        const payload = JSON.parse(await readBlob(lastBlob()));
        expect(payload).toMatchObject({ schema: 'silvia-chinellato-backup', schemaVersion: 1, exportedBy: 'silviachine@gmail.com' });
        expect(payload.counts).toMatchObject({ patients: 1, events: 1, centers: 1, manualRevenues: 1, taxProfiles: 0 });
        expect(payload.data.patients[0].id).toBe('p1');
        expect(app.window.localStorage.getItem('lastCompleteBackupAt')).toBe(payload.createdAt);
        expect(app.text('backup-last-export')).toMatch(/^Ultimo export da questo dispositivo:/);
        expect(app.toast()).toBe('Backup completo esportato.');
    });

    it('analizza un backup valido e abilita il ripristino', async () => {
        await loggedIn();
        app.window.openBackupModal();
        await analyze(backupFile(validBackup()));
        expect(app.isHidden('backup-analysis')).toBe(false);
        expect(app.text('backup-analysis')).toContain('Backup valido');
        expect(app.text('backup-analysis')).toContain('Pazienti: 1');
        expect(app.byId('backup-restore-btn').disabled).toBe(false);
    });

    it.each([
        ['JSON non valido', backupFile('{ non json'), /JSON|Unexpected|Expected/],
        ['schema sconosciuto', backupFile({ schema: 'altro' }), /Formato backup non riconosciuto/],
        ['file oltre 25 MB', backupFile(validBackup(), 26 * 1024 * 1024), /supera il limite di 25 MB/]
    ])('rifiuta un %s', async (_label, file, message) => {
        await loggedIn();
        app.window.openBackupModal();
        await analyze(file);
        expect(app.text('backup-analysis')).toContain('Backup non valido');
        expect(app.text('backup-analysis')).toMatch(message);
        expect(app.byId('backup-restore-btn').disabled).toBe(true);
        expect(app.toast()).toBe('File di backup non valido.');
    });

    it('ripristina tutte le sezioni su Firestore senza eliminare i dati esistenti', async () => {
        await loggedIn({ patients: [patient({ id: 'existing', name: 'Esistente' })] });
        app.window.openBackupModal();
        await analyze(backupFile(validBackup()));
        app.window.requestBackupRestore();
        expect(app.text('confirm-text')).toContain('Verranno aggiunti o sovrascritti 1 pazienti, 1 appuntamenti e 1 sedute cliniche');
        await app.confirm();
        await app.waitFor(() => app.text('backup-progress') === 'Ripristino completato con successo.', 'ripristino');
        expect(app.mock.has(`${SHARED}/patients_list/rp1`)).toBe(true);
        expect(app.mock.has(`${SHARED}/patients_list/existing`)).toBe(true);
        expect(app.mock.has(`${SHARED}/studio_events/re1`)).toBe(true);
        expect(app.mock.has(`${SHARED}/clinical_sessions/re1`)).toBe(true);
        expect(app.mock.has(`${SHARED}/centers_list/rc1`)).toBe(true);
        expect(app.mock.has(`${PUBLIC}/centers_list/rc1`)).toBe(true);
        expect(app.mock.has(`${PUBLIC}/treatments_list/rt1`)).toBe(true);
        expect(app.mock.has(`${PUBLIC}/news_list/rn1`)).toBe(true);
        expect(app.mock.has(`${PUBLIC}/preparations_list/rpr1`)).toBe(true);
        expect(app.mock.has(`${SHARED}/manual_revenue/rr1`)).toBe(true);
        expect(app.mock.get(`${SHARED}/tax_profile/default`)).toMatchObject({ id: 'default', previousYearRevenue: 1 });
        expect(app.state.patients.map(p => p.id).sort()).toEqual(['existing', 'rp1']);
        expect(app.toast()).toBe('Ripristino completato.');
        expect(app.mock.listenerCount()).toBeGreaterThan(0); // sincronizzazione realtime riattivata
    });

    it('interrompe il ripristino in caso di errore e riattiva la sincronizzazione', async () => {
        await loggedIn();
        app.window.openBackupModal();
        await analyze(backupFile(validBackup()));
        app.mock.failNext('setDoc', `${SHARED}/patients_list`);
        app.window.requestBackupRestore();
        await app.confirm();
        expect(app.text('backup-progress')).toMatch(/^Ripristino interrotto:/);
        expect(app.toast()).toBe('Errore: operazione non completata.');
        expect(app.mock.listenerCount()).toBeGreaterThan(0);
    });
});
