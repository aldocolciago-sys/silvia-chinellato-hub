import { describe, it, expect, vi, beforeEach } from 'vitest';

// Firebase Admin simulato: Firestore in memoria con query, transazioni, getAll e update.
const admin = vi.hoisted(() => ({ docs: {}, writes: [], queries: [], apps: [], updateError: null }));
vi.mock('firebase-admin/app', () => ({
    getApps: () => admin.apps,
    cert: (json) => ({ json }),
    initializeApp: (options) => { const app = { options }; admin.apps.push(app); return app; }
}));
vi.mock('firebase-admin/firestore', () => {
    const snap = (path) => ({ id: path.split('/').pop(), exists: path in admin.docs, data: () => admin.docs[path] });
    const docRef = (path) => ({
        path,
        get: async () => snap(path),
        set: async (data, options) => { admin.writes.push({ op: 'set', path, data, options }); admin.docs[path] = options?.merge ? { ...(admin.docs[path] || {}), ...data } : data; },
        update: async (patch) => {
            if (admin.updateError) throw admin.updateError;
            if (!(path in admin.docs)) throw Object.assign(new Error('5 NOT_FOUND: No document to update'), { code: 5 });
            admin.writes.push({ op: 'update', path, data: patch });
        }
    });
    const inCollection = (path) => Object.keys(admin.docs).filter(key => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/'));
    return {
        getFirestore: () => ({
            doc: docRef,
            collection: (path) => ({
                get: async () => ({ docs: inCollection(path).map(snap) }),
                where: (field, op, value) => ({
                    get: async () => {
                        admin.queries.push({ path, field, op, value });
                        return { docs: inCollection(path).filter(key => String(admin.docs[key][field]) >= value).map(snap) };
                    }
                })
            }),
            getAll: async (...refs) => refs.map(ref => snap(ref.path)),
            runTransaction: async (fn) => fn({ get: async (ref) => snap(ref.path), set: (ref, data, options) => ref.set(data, options) })
        })
    };
});

import handlerDefault, { createHandler, realDeps } from '../../api/calendar-sync.js';
import {
    runCalendarSync, buildChangeMessage, buildActivationMessage, alertableChanges, mergeOutbox, syncWindowStart, syncAlertsEnabled,
    downloadCalendar, firestoreSyncDeps, MAX_ALERT_LINES, OUTBOX_MAX, LOCK_RETRIES
} from '../../api/_calendar-sync.js';
import { createHandler as createDigestHandler } from '../../api/daily-reminder.js';
import { buildDigest } from '../../api/_daily-reminder-core.js';
import { createMockReq, createMockRes } from '../support/vercel-mock.js';
import { vcalendar, vevent } from '../fixtures/ical.js';

const ROOT = 'artifacts/silvia-chinellato-app/shared/data';
// Martedì 10 novembre 2026, 15:00 a Roma (ora solare, UTC+1).
const NOW = new Date('2026-11-10T14:00:00.000Z');
const CENTERS = [
    { id: 'cms', name: 'CMS Carate', icalUrl: 'https://cal.example/cms.ics', service: 'Idrocolonterapia', rateIdrocolonterapia: 40 },
    { id: 'sport', name: 'Medicina dello Sport', icalUrl: 'https://cal.example/sport.ics', isNonClinicalCalendar: true, isShiftCalendar: true, hourlyRate: 30 },
    { id: 'casa', name: 'Personale', icalUrl: 'https://cal.example/casa.ics', isNonClinicalCalendar: true },
    { id: 'studio', name: 'Studio' }
];
const PATIENTS = [{ id: 'p1', name: 'Maria Rossi' }, { id: 'p2', name: 'Anna Bianchi' }];
const ev = (id, start, end, props = {}, title = 'Maria Rossi') => ({ id, title, start, end, backgroundColor: '#3f5e4e', borderColor: '#3f5e4e', textColor: '#ffffff', extendedProps: { centerId: 'cms', centerName: 'CMS Carate', patientId: 'p1', isNonClinical: false, fee: 40, ...props } });
const cal = (...events) => vcalendar(events.map(vevent));

function makeDeps({ feeds = {}, events = [], syncState = { initializedAt: '2026-11-01T00:00:00.000Z' }, messagingSettings = { dailyDigestEnabled: true }, ...overrides } = {}) {
    return {
        canSend: true,
        send: vi.fn(async () => 'ok'),
        sleep: vi.fn(async () => {}),
        acquireLock: vi.fn(async () => true),
        releaseLock: vi.fn(async () => {}),
        fetchCalendar: vi.fn(async (url) => { const key = url.match(/\/(\w+)\.ics$/)?.[1]; if (feeds[key] instanceof Error) throw feeds[key]; return feeds[key] ?? null; }),
        loadSyncData: vi.fn(async () => ({ centers: CENTERS, events, patients: PATIENTS, messagingSettings, syncState })),
        loadEventsByIds: vi.fn(async () => []),
        applyWrites: vi.fn(async () => {}),
        saveSyncState: vi.fn(async () => {}),
        ...overrides
    };
}
const sent = (deps) => deps.send.mock.calls.map(c => c[0]);
const savedState = (deps) => deps.saveSyncState.mock.calls.at(-1)[0];

describe('runCalendarSync – avvisi WhatsApp', () => {
    it('avvisa di nuovi, spostati e cancellati dei poliambulatori e dei turni, solo con le iniziali', async () => {
        const deps = makeDeps({
            events: [
                ev('ical_cms_moved', '2026-11-12T09:00:00.000Z', '2026-11-12T10:00:00.000Z'),
                ev('ical_cms_gone', '2026-11-16T08:00:00.000Z', '2026-11-16T09:00:00.000Z', { patientId: 'p2' }, 'Anna Bianchi'),
                ev('ical_sport_t', '2026-11-13T07:00:00.000Z', '2026-11-13T12:00:00.000Z', { centerId: 'sport', centerName: 'Medicina dello Sport', patientId: null, isNonClinical: true, fee: 150 }, 'Turno')
            ],
            feeds: {
                cms: cal(
                    { uid: 'moved', summary: 'Maria Rossi', start: '20261113T103000Z', end: '20261113T113000Z' },
                    { uid: 'new', summary: 'Anna Bianchi idrocolon', start: '20261111T090000Z', end: '20261111T100000Z' },
                    { uid: 'old', summary: 'Passato', start: '20261101T090000Z' }
                ),
                sport: cal({ uid: 't', summary: 'Turno', start: '20261113T070000Z', end: '20261113T130000Z' }),
                casa: cal({ uid: 'cena', summary: 'Cena da Maria Rossi', start: '20261111T190000Z' })
            }
        });
        const result = await runCalendarSync(deps, { now: NOW, appUrl: 'https://agenda.example' });
        expect(result).toEqual({ status: 'ok', writes: 5, notified: true, counts: { added: 2, modified: 2, removed: 1, restored: 0, failed: 0, suspicious: 0 } });
        expect(sent(deps)).toEqual([[
            '🔄 *Agenda aggiornata*',
            '',
            '❌ *Cancellati dal calendario originale* (1)',
            '• lun 16/11 09:00 – A.B. – Idrocolonterapia – CMS Carate',
            'Restano in agenda finché non scegli se tenerli o toglierli: apri l\'app → Ultime novità.',
            '',
            '✏️ *Modificati* (2)',
            '• ven 13/11 08:00–13:00 → 08:00–14:00 – 🩺 Turno – Medicina dello Sport',
            '• gio 12/11 10:00 → ven 13/11 11:30 – M.R. – Idrocolonterapia – CMS Carate',
            '',
            '➕ *Nuovi* (1)',
            '• mer 11/11 10:00 – A.B. – Idrocolonterapia – CMS Carate',
            '',
            'Apri l\'agenda: https://agenda.example'
        ].join('\n')]);
        expect(sent(deps)[0]).not.toMatch(/Maria|Anna|Rossi|Bianchi|Cena/);
        expect(deps.loadSyncData).toHaveBeenCalledWith('2026-11-07T23:00:00.000Z');
        const state = savedState(deps);
        expect(state).toMatchObject({ lastRunAt: NOW.toISOString(), lastAlertAt: NOW.toISOString(), lastAlertError: null, outbox: [], lockUntil: null, lastFailed: [], lastSuspicious: [] });
        // Il registro tiene tutto, anche il calendario personale e l'appuntamento passato.
        expect(state.recentChanges.map(c => `${c.type}:${c.id}`).sort()).toEqual(['added:ical_casa_cena', 'added:ical_cms_new', 'modified:ical_cms_moved', 'modified:ical_sport_t', 'removed:ical_cms_gone']);
    });

    it('senza novità non manda messaggi', async () => {
        const deps = makeDeps({ events: [ev('ical_cms_a', '2026-11-12T09:00:00.000Z', '2026-11-12T10:00:00.000Z')], feeds: { cms: cal({ uid: 'a', summary: 'Maria Rossi', start: '20261112T090000Z', end: '20261112T100000Z' }), sport: cal(), casa: cal() } });
        const result = await runCalendarSync(deps, { now: NOW });
        expect(result).toMatchObject({ status: 'ok', writes: 0, notified: false });
        expect(deps.send).not.toHaveBeenCalled();
    });

    it('con il calendario che sparisce in blocco avvisa una volta al giorno senza segnare cancellazioni', async () => {
        const events = Array.from({ length: 6 }, (_, i) => ev(`ical_cms_${i}`, `2026-11-2${i}T09:00:00.000Z`, `2026-11-2${i}T10:00:00.000Z`));
        const feeds = { cms: cal({ uid: 'vecchio', summary: 'x', start: '20250101T090000Z' }), sport: cal(), casa: cal() };
        const deps = makeDeps({ events, feeds });
        await runCalendarSync(deps, { now: NOW });
        expect(sent(deps)[0]).toContain('⚠️ CMS Carate: risultano spariti 6 appuntamenti futuri tutti insieme.');
        expect(sent(deps)[0]).not.toContain('Cancellati');
        expect(deps.applyWrites.mock.calls[0][0]).toEqual([]);
        expect(savedState(deps).suspiciousNotified).toEqual({ cms: '2026-11-10' });

        const again = makeDeps({ events, feeds, syncState: { initializedAt: 'x', suspiciousNotified: { cms: '2026-11-10' } } });
        await runCalendarSync(again, { now: NOW });
        expect(again.send).not.toHaveBeenCalled();
    });

    it('il primo controllo manda solo la conferma di attivazione con i cancellati da decidere', async () => {
        const deps = makeDeps({
            syncState: null,
            events: [
                ev('ical_cms_a', '2026-11-12T09:00:00.000Z', '2026-11-12T10:00:00.000Z', { externalRemovalPending: true }),
                ev('ical_cms_b', '2026-11-13T09:00:00.000Z', '2026-11-13T10:00:00.000Z', { externalRemovalPending: true }),
                ev('ical_cms_c', '2026-11-14T09:00:00.000Z', '2026-11-14T10:00:00.000Z')
            ],
            feeds: { cms: cal({ uid: 'b', summary: 'Maria Rossi', start: '20261113T090000Z', end: '20261113T100000Z' }, { uid: 'n', summary: 'Nuovo', start: '20261120T090000Z' }), sport: cal(), casa: cal() }
        });
        await runCalendarSync(deps, { now: NOW, appUrl: 'https://agenda.example' });
        expect(sent(deps)).toEqual([buildActivationMessage({ pendingCount: 2, appUrl: 'https://agenda.example' })]);
        expect(sent(deps)[0]).toContain('2 appuntamenti risultano cancellati');
        expect(savedState(deps).initializedAt).toBe(NOW.toISOString());
    });

    it('se WhatsApp non risponde le novità restano in coda e partono la volta dopo', async () => {
        const feeds = { cms: cal({ uid: 'n', summary: 'Maria Rossi', start: '20261111T090000Z' }), sport: cal(), casa: cal() };
        const failing = makeDeps({ feeds, send: vi.fn(async () => { throw new Error('CallMeBot non raggiungibile'); }) });
        const result = await runCalendarSync(failing, { now: NOW });
        expect(result.notified).toBe(false);
        expect(savedState(failing)).toMatchObject({ lastAlertError: 'CallMeBot non raggiungibile', lastAlertErrorAt: NOW.toISOString() });
        const outbox = savedState(failing).outbox;
        expect(outbox.map(c => c.id)).toEqual(['ical_cms_n']);

        const retry = makeDeps({ feeds: { cms: cal(), sport: cal(), casa: cal() }, syncState: { initializedAt: 'x', outbox } });
        await runCalendarSync(retry, { now: NOW });
        expect(sent(retry)[0]).toContain('➕ *Nuovi* (1)\n• mer 11/11 10:00 – M.R. – Idrocolonterapia – CMS Carate');
        expect(savedState(retry).outbox).toEqual([]);
    });

    it('se la conferma di attivazione non parte, riprova al controllo successivo', async () => {
        const deps = makeDeps({ syncState: null, feeds: { cms: cal(), sport: cal(), casa: cal() }, send: vi.fn(async () => { throw new Error('giù'); }) });
        await runCalendarSync(deps, { now: NOW });
        expect(savedState(deps).initializedAt).toBeUndefined();
        expect(savedState(deps).outbox).toEqual([]);
    });

    it('con gli avvisi spenti o CallMeBot non configurato aggiorna l’agenda senza scrivere', async () => {
        const feeds = { cms: cal({ uid: 'n', summary: 'Maria Rossi', start: '20261111T090000Z' }), sport: cal(), casa: cal() };
        for (const deps of [
            makeDeps({ feeds, messagingSettings: { dailyDigestEnabled: true, syncAlertsEnabled: false }, syncState: { initializedAt: 'x', outbox: [{ type: 'added', id: 'vecchio' }] } }),
            makeDeps({ feeds, messagingSettings: null }),
            makeDeps({ feeds, canSend: false })
        ]) {
            const result = await runCalendarSync(deps, { now: NOW });
            expect(result.writes).toBe(1);
            expect(deps.send).not.toHaveBeenCalled();
            expect(savedState(deps).outbox).toEqual([]);
        }
    });

    it('rilegge un appuntamento "nuovo" già in agenda con una data fuori finestra, senza perdere i suoi dati', async () => {
        const stored = ev('ical_cms_back', '2026-10-01T09:00:00.000Z', '2026-10-01T10:00:00.000Z', { fee: 70, notes: 'nota' });
        const deps = makeDeps({ feeds: { cms: cal({ uid: 'back', summary: 'Maria Rossi', start: '20261120T090000Z', end: '20261120T100000Z' }), sport: cal(), casa: cal() }, loadEventsByIds: vi.fn(async () => [stored]) });
        await runCalendarSync(deps, { now: NOW });
        expect(deps.loadEventsByIds).toHaveBeenCalledWith(['ical_cms_back']);
        const [write] = deps.applyWrites.mock.calls[0][0];
        expect(write).toMatchObject({ isNew: false, patch: { start: '2026-11-20T09:00:00.000Z', end: '2026-11-20T10:00:00.000Z' } });
        expect(write.data.extendedProps).toMatchObject({ fee: 70, notes: 'nota' });
    });

    it('un calendario che non si scarica è riportato senza toccare i suoi appuntamenti', async () => {
        const deps = makeDeps({ events: [ev('ical_cms_a', '2026-11-12T09:00:00.000Z', '2026-11-12T10:00:00.000Z')], feeds: { cms: new Error('rete'), sport: null, casa: cal() } });
        const result = await runCalendarSync(deps, { now: NOW });
        expect(result.counts).toMatchObject({ failed: 2, removed: 0 });
        expect(savedState(deps).lastFailed).toEqual(['CMS Carate', 'Medicina dello Sport']);
        expect(deps.fetchCalendar).toHaveBeenCalledWith('https://cal.example/cms.ics');
    });
});

describe('runCalendarSync – lucchetto', () => {
    it('se un’altra sincronizzazione è in corso non fa nulla', async () => {
        const deps = makeDeps({ acquireLock: vi.fn(async () => false) });
        await expect(runCalendarSync(deps, { now: NOW })).resolves.toEqual({ status: 'busy' });
        expect(deps.loadSyncData).not.toHaveBeenCalled();
        expect(deps.sleep).not.toHaveBeenCalled();
    });

    it('per il riepilogo delle 7 aspetta che finisca', async () => {
        const deps = makeDeps({ acquireLock: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true), feeds: { cms: cal(), sport: cal(), casa: cal() } });
        await expect(runCalendarSync(deps, { now: NOW, waitForLock: true })).resolves.toMatchObject({ status: 'ok' });
        expect(deps.sleep).toHaveBeenCalledTimes(1);
        const never = makeDeps({ acquireLock: vi.fn(async () => false) });
        await expect(runCalendarSync(never, { now: NOW, waitForLock: true })).resolves.toEqual({ status: 'busy' });
        expect(never.sleep).toHaveBeenCalledTimes(LOCK_RETRIES);
    });

    it('in caso di errore libera il lucchetto e propaga l’errore', async () => {
        const deps = makeDeps({ loadSyncData: vi.fn(async () => { throw new Error('Firestore giù'); }), releaseLock: vi.fn(async () => { throw new Error('anche questo'); }) });
        await expect(runCalendarSync(deps, { now: NOW })).rejects.toThrow('Firestore giù');
        expect(deps.releaseLock).toHaveBeenCalled();
    });
});

describe('testo dell’avviso', () => {
    const base = { kind: 'clinical', centerId: 'cms', centerName: 'CMS Carate', patientId: 'p1', title: 'Maria Rossi' };
    const msg = (changes, extra = {}) => buildChangeMessage({ changes, patients: PATIENTS, centers: CENTERS, ...extra });

    it('descrive le modifiche di sola fine, di solo titolo e gli appuntamenti ricomparsi', () => {
        const text = msg([
            { ...base, type: 'modified', id: 'a', start: '2026-11-12T09:00:00.000Z', end: '2026-11-12T10:30:00.000Z', before: { title: 'Maria Rossi', start: '2026-11-12T09:00:00.000Z', end: '2026-11-12T10:00:00.000Z' } },
            { ...base, type: 'modified', id: 'b', patientId: null, start: '2026-11-13T09:00:00.000Z', end: '2026-11-13T10:00:00.000Z', before: { title: 'Vecchio', start: '2026-11-13T09:00:00.000Z', end: '2026-11-13T10:00:00.000Z' } },
            { ...base, kind: 'shift', centerId: 'sport', centerName: '', type: 'modified', id: 'c', start: '2026-11-14T07:00:00.000Z', end: null, before: { title: 'x', start: '2026-11-14T07:00:00.000Z', end: null } },
            { ...base, type: 'restored', id: 'd', centerId: 'studio', centerName: 'Studio Privato', start: '2026-11-15T09:00:00.000Z', end: '2026-11-15T10:00:00.000Z' }
        ]);
        expect(text).toContain('• gio 12/11 10:00–11:00 → 10:00–11:30 – M.R. – Idrocolonterapia – CMS Carate');
        expect(text).toContain('• ven 13/11 10:00 – senza paziente – Idrocolonterapia – CMS Carate (titolo cambiato, controlla il paziente)');
        expect(text).toContain('• sab 14/11 08:00 – 🩺 Turno – Medicina dello Sport (titolo cambiato)');
        expect(text).toContain('↩️ *Di nuovo nel calendario originale* (non serve scegliere) (1)\n• dom 15/11 10:00 – M.R. – studio');
    });

    it('limita il numero di righe e rimanda all’app per il resto', () => {
        const changes = Array.from({ length: MAX_ALERT_LINES + 4 }, (_, i) => ({ ...base, type: i % 2 ? 'added' : 'removed', id: `e${i}`, start: new Date(Date.UTC(2026, 10, 11, 8, i)).toISOString() }));
        const text = msg(changes);
        expect(text.split('\n').filter(line => line.startsWith('• '))).toHaveLength(MAX_ALERT_LINES);
        expect(text).toContain('…e altre 4 novità: le trovi nell\'app, in Ultime novità.');
        expect(text).not.toContain('Apri l\'agenda');
    });

    it('conferma di attivazione senza cancellati o con uno solo', () => {
        expect(buildActivationMessage({})).toBe('✅ *Sincronizzazione automatica dell\'agenda attiva*\nOgni ora controllo i calendari dei poliambulatori e dei turni e ti scrivo qui solo quando cambia qualcosa.');
        expect(buildActivationMessage({ pendingCount: 1 })).toContain("1 appuntamento risulta cancellato dal calendario originale: scegli nell'app se tenerlo o toglierlo");
    });
});

describe('funzioni di supporto', () => {
    it('avvisa solo per poliambulatori e turni da oggi in poi', () => {
        const changes = [
            { kind: 'clinical', start: '2026-11-09T23:30:00.000Z' }, // oggi, 00:30 a Roma
            { kind: 'clinical', start: '2026-11-09T22:30:00.000Z' }, // ieri
            { kind: 'clinical', start: '2026-11-01T09:00:00.000Z', before: { start: '2026-11-20T09:00:00.000Z' } },
            { kind: 'shift', start: '2026-11-12T07:00:00.000Z' },
            { kind: 'personal', start: '2026-11-12T07:00:00.000Z' },
            { kind: 'clinical', start: null }
        ];
        expect(alertableChanges(changes, NOW)).toEqual([changes[0], changes[2], changes[3]]);
    });

    it('la coda tiene l’ultima versione di ogni novità ed è limitata', () => {
        expect(mergeOutbox([{ type: 'added', id: 'a', v: 1 }, { type: 'removed', id: 'a' }], [{ type: 'added', id: 'a', v: 2 }])).toEqual([{ type: 'removed', id: 'a' }, { type: 'added', id: 'a', v: 2 }]);
        expect(mergeOutbox(undefined, Array.from({ length: OUTBOX_MAX + 5 }, (_, i) => ({ type: 'added', id: String(i) })))).toHaveLength(OUTBOX_MAX);
        expect(mergeOutbox()).toEqual([]);
    });

    it('finestra di lettura: da due giorni fa a mezzanotte, ora di Roma', () => {
        expect(syncWindowStart(NOW)).toBe('2026-11-07T23:00:00.000Z');
        expect(syncWindowStart(new Date('2026-07-10T10:00:00Z'))).toBe('2026-07-07T22:00:00.000Z');
    });

    it('avvisi attivi se scelti, altrimenti insieme al riepilogo delle 7', () => {
        expect(syncAlertsEnabled({ syncAlertsEnabled: true })).toBe(true);
        expect(syncAlertsEnabled({ dailyDigestEnabled: true })).toBe(true);
        expect(syncAlertsEnabled({ dailyDigestEnabled: true, syncAlertsEnabled: false })).toBe(false);
        expect(syncAlertsEnabled(null)).toBe(false);
    });

    it('scarica solo calendari validi', async () => {
        const ok = { ok: true, text: async () => 'BEGIN:VCALENDAR\nEND:VCALENDAR' };
        await expect(downloadCalendar('https://x', { fetchUrl: async () => ok })).resolves.toContain('BEGIN:VCALENDAR');
        await expect(downloadCalendar('https://x', { fetchUrl: async () => ({ ok: true, text: async () => '<html>' }) })).resolves.toBeNull();
        await expect(downloadCalendar('https://x', { fetchUrl: async () => ({ ok: false }) })).resolves.toBeNull();
    });
});

describe('api/calendar-sync', () => {
    const ENV = { CRON_SECRET: 'segreto-cron', FIREBASE_SERVICE_ACCOUNT: '{"x":1}', APP_URL: 'https://agenda.example' };
    const call = async (deps, { method = 'GET', token = 'segreto-cron' } = {}) => {
        const res = createMockRes();
        await createHandler(deps)(createMockReq({ method, headers: token ? { authorization: `Bearer ${token}` } : {} }), res);
        return res;
    };
    const deps = (run) => ({ env: ENV, now: () => NOW, run: vi.fn(run) });

    it('sincronizza e risponde solo con dei conteggi', async () => {
        const d = deps(async () => ({ status: 'ok', writes: 3, counts: { added: 1 }, notified: true }));
        const res = await call(d);
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ status: 'ok', counts: { added: 1 }, notified: true });
        expect(res.headers['cache-control']).toBe('no-store');
        expect(d.run).toHaveBeenCalledWith({ now: NOW, appUrl: 'https://agenda.example' });
    });

    it('accetta solo GET con il segreto dei cron', async () => {
        const d = deps(async () => ({ status: 'ok' }));
        expect((await call(d, { method: 'POST' })).statusCode).toBe(405);
        expect((await call(d, { token: 'sbagliato' })).statusCode).toBe(401);
        expect((await call(d, { token: null })).statusCode).toBe(401);
        expect(d.run).not.toHaveBeenCalled();
    });

    it('segnala la configurazione mancante, la sincronizzazione già in corso e gli errori', async () => {
        const missing = await call({ ...deps(async () => ({})), env: { CRON_SECRET: 'segreto-cron' } });
        expect(missing.statusCode).toBe(500);
        expect(missing.body.error).toContain('FIREBASE_SERVICE_ACCOUNT');
        expect((await call(deps(async () => ({ status: 'busy' })))).body).toEqual({ status: 'busy', reason: 'Sincronizzazione già in corso' });
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const failed = await call(deps(async () => { throw new Error('dettaglio interno'); }));
        expect(failed.statusCode).toBe(500);
        expect(failed.body).toEqual({ error: 'Sincronizzazione non riuscita' });
        const config = await call(deps(async () => { throw Object.assign(new Error('Chiave non valida'), { code: 'config/service-account' }); }));
        expect(config.body).toEqual({ error: 'Chiave non valida' });
    });

    it('il gestore predefinito è pronto all’uso', async () => {
        const res = createMockRes();
        await handlerDefault(createMockReq({ method: 'GET', headers: {} }), res);
        expect(res.statusCode).toBe(401);
        expect(typeof realDeps({}).run).toBe('function');
        expect(Math.abs(realDeps({}).now() - Date.now())).toBeLessThan(1000);
    });
});

describe('dipendenze Firestore della sincronizzazione', () => {
    const SERVICE_ACCOUNT = JSON.stringify({ project_id: 'x', client_email: 'bot@x', private_key: 'k' });
    const ENV = { FIREBASE_SERVICE_ACCOUNT: SERVICE_ACCOUNT, CALLMEBOT_PHONE: '+39333', CALLMEBOT_APIKEY: 'chiave' };
    let clock;
    beforeEach(() => {
        Object.assign(admin, { docs: {}, writes: [], queries: [], updateError: null });
        clock = Date.parse('2026-11-10T14:00:00.000Z');
    });
    const make = (env = ENV, fetchImpl) => firestoreSyncDeps(env, { clock: () => clock, ...(fetchImpl ? { fetchImpl } : {}) });

    it('il lucchetto blocca una seconda sincronizzazione finché non scade o viene liberato', async () => {
        const deps = make();
        await expect(deps.acquireLock()).resolves.toBe(true);
        expect(admin.docs[`${ROOT}/settings/calendar_sync`].lockUntil).toBe('2026-11-10T14:03:00.000Z');
        await expect(deps.acquireLock()).resolves.toBe(false);
        clock += 4 * 60 * 1000;
        await expect(deps.acquireLock()).resolves.toBe(true);
        await deps.releaseLock();
        await expect(deps.acquireLock()).resolves.toBe(true);
    });

    it('legge sedi, appuntamenti dalla finestra in poi, pazienti, impostazioni e stato', async () => {
        admin.docs[`${ROOT}/centers_list/cms`] = CENTERS[0];
        admin.docs[`${ROOT}/studio_events/ical_cms_a`] = { title: 'Nuovo', start: '2026-11-12T09:00:00.000Z' };
        admin.docs[`${ROOT}/studio_events/ical_cms_old`] = { id: 'ical_cms_old', start: '2026-10-01T09:00:00.000Z' };
        admin.docs[`${ROOT}/patients_list/doc1`] = { name: 'Maria Rossi' };
        admin.docs[`${ROOT}/settings/messaging`] = { dailyDigestEnabled: true };
        const data = await make().loadSyncData('2026-11-07T23:00:00.000Z');
        expect(data).toEqual({
            centers: [CENTERS[0]],
            events: [{ id: 'ical_cms_a', title: 'Nuovo', start: '2026-11-12T09:00:00.000Z' }],
            patients: [{ id: 'doc1', name: 'Maria Rossi' }],
            messagingSettings: { dailyDigestEnabled: true },
            syncState: null
        });
        expect(admin.queries).toEqual([{ path: `${ROOT}/studio_events`, field: 'start', op: '>=', value: '2026-11-07T23:00:00.000Z' }]);
        admin.docs[`${ROOT}/settings/calendar_sync`] = { initializedAt: 'x' };
        delete admin.docs[`${ROOT}/settings/messaging`];
        expect(await make().loadSyncData('2026-11-07')).toMatchObject({ messagingSettings: null, syncState: { initializedAt: 'x' } });
    });

    it('rilegge per id solo gli appuntamenti esistenti', async () => {
        admin.docs[`${ROOT}/studio_events/ical_cms_a`] = { id: 'ical_cms_a', start: 'x' };
        await expect(make().loadEventsByIds(['ical_cms_a', 'ical_cms_b'])).resolves.toEqual([{ id: 'ical_cms_a', start: 'x' }]);
    });

    it('crea i nuovi con merge, aggiorna solo i campi cambiati e ignora gli appuntamenti appena eliminati', async () => {
        admin.docs[`${ROOT}/studio_events/esistente`] = { id: 'esistente' };
        const deps = make();
        await deps.applyWrites([
            { id: 'nuovo', isNew: true, data: { id: 'nuovo', title: 'x' } },
            { id: 'esistente', isNew: false, patch: { start: 'y' } },
            { id: 'eliminato', isNew: false, patch: { start: 'z' } }
        ]);
        expect(admin.writes).toEqual([
            { op: 'set', path: `${ROOT}/studio_events/nuovo`, data: { id: 'nuovo', title: 'x' }, options: { merge: true } },
            { op: 'update', path: `${ROOT}/studio_events/esistente`, data: { start: 'y' } }
        ]);
        admin.updateError = new Error('PERMISSION_DENIED');
        await expect(deps.applyWrites([{ id: 'esistente', isNew: false, patch: {} }])).rejects.toThrow('PERMISSION_DENIED');
    });

    it('salva lo stato, sa se può scrivere su WhatsApp e invia con CallMeBot', async () => {
        const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => 'Message queued' }));
        const deps = make(ENV, fetchImpl);
        await deps.saveSyncState({ lastRunAt: 'x' });
        expect(admin.docs[`${ROOT}/settings/calendar_sync`]).toEqual({ lastRunAt: 'x', updatedAt: '2026-11-10T14:00:00.000Z' });
        expect(deps.canSend).toBe(true);
        expect(make({ ...ENV, CALLMEBOT_APIKEY: ' ' }).canSend).toBe(false);
        await deps.send('ciao');
        expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.get('text')).toBe('ciao');
        await expect(deps.sleep(1)).resolves.toBeUndefined();
        await expect(deps.fetchCalendar('http://127.0.0.1/cal.ics')).rejects.toThrow(/indirizzo pubblico/);
    });

    it('usa il fetch globale per CallMeBot se non ne viene passato uno', async () => {
        const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => 'ok' }));
        vi.stubGlobal('fetch', fetchMock);
        await firestoreSyncDeps(ENV).send('ciao');
        expect(fetchMock).toHaveBeenCalled();
        vi.unstubAllGlobals();
    });
});

describe('riepilogo delle 7 con sincronizzazione', () => {
    const ENV = { CRON_SECRET: 'segreto-cron', CALLMEBOT_PHONE: '+39333', CALLMEBOT_APIKEY: 'chiave', FIREBASE_SERVICE_ACCOUNT: '{}', APP_URL: 'https://agenda.example' };
    const SEVEN_AM = new Date('2026-11-10T06:00:00Z');
    const before = { events: [{ id: 'a', start: '2026-11-10T09:00:00', title: 'Osteopatia', extendedProps: { patientId: 'p1' } }], patients: [{ id: 'p1', name: 'Maria Rossi', phone: '333 1234567' }], centers: [], messagingSettings: { dailyDigestEnabled: true }, status: null };
    const after = { ...before, events: [{ ...before.events[0], extendedProps: { patientId: 'p1', externalRemovalPending: true } }] };
    const digestDeps = (overrides) => ({
        env: ENV, now: () => SEVEN_AM,
        fetch: vi.fn(async () => ({ ok: true, status: 200, text: async () => 'Message queued' })),
        verifyUser: vi.fn(),
        loadData: vi.fn().mockResolvedValueOnce(before).mockResolvedValue(after),
        saveStatus: vi.fn(async () => {}),
        ...overrides
    });
    const callDigest = async (deps, method = 'GET') => {
        const res = createMockRes();
        await createDigestHandler(deps)(createMockReq({ method, headers: { authorization: `Bearer ${method === 'GET' ? 'segreto-cron' : 'token'}` } }), res);
        return res;
    };
    const digestText = (deps) => new URL(deps.fetch.mock.calls.at(-1)[0]).searchParams.get('text');

    it('sincronizza prima e, se l’agenda è cambiata, rilegge i dati', async () => {
        const deps = digestDeps({ syncCalendars: vi.fn(async () => ({ status: 'ok', writes: 1 })) });
        const res = await callDigest(deps);
        expect(res.body.counts).toMatchObject({ removalPending: 1, pending: 0 });
        expect(deps.syncCalendars).toHaveBeenCalledWith(SEVEN_AM, 'https://agenda.example');
        expect(deps.loadData).toHaveBeenCalledTimes(2);
        expect(digestText(deps)).toContain('• 09:00 – M.R. – Osteopatia – studio ❌ cancellato dal calendario originale');
        expect(digestText(deps)).toContain('❌ 1 appuntamento cancellato dal calendario originale: scegli nell\'app se tenerlo o toglierlo');
        expect(digestText(deps)).not.toContain('promemoria da inviare');
    });

    it('senza modifiche, con la sincronizzazione occupata o in errore invia comunque il riepilogo', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        for (const syncCalendars of [vi.fn(async () => ({ status: 'ok', writes: 0 })), vi.fn(async () => ({ status: 'busy' })), vi.fn(async () => { throw new Error('giù'); })]) {
            const deps = digestDeps({ syncCalendars });
            const res = await callDigest(deps);
            expect(res.body.status).toBe('sent');
            expect(deps.loadData).toHaveBeenCalledTimes(1);
        }
    });

    it('la prova dall’app non sincronizza', async () => {
        const deps = digestDeps({ syncCalendars: vi.fn(), verifyUser: vi.fn(async () => ({ email: 'silviachine@gmail.com', email_verified: true })) });
        const res = await callDigest(deps, 'POST');
        expect(res.body.status).toBe('sent');
        expect(deps.syncCalendars).not.toHaveBeenCalled();
    });

    it('conta tutti i cancellati da decidere, anche quelli dei prossimi giorni', () => {
        const events = [
            { id: 'x', start: '2026-11-20T09:00:00', title: 'Osteopatia', extendedProps: { externalRemovalPending: true } },
            { id: 'y', start: '2026-11-21T09:00:00', title: 'Osteopatia', extendedProps: { externalRemovalPending: true } },
            { id: 'k', start: '2026-11-22T09:00:00', title: 'Osteopatia', extendedProps: { externalRemovalPending: true, detachedFromExternal: true } }
        ];
        const { text, counts } = buildDigest({ events }, SEVEN_AM);
        expect(counts.removalPending).toBe(2);
        expect(text).toContain("❌ 2 appuntamenti cancellati dal calendario originale: scegli nell'app se tenerli o toglierli");
    });

    it('un turno o un impegno personale cancellato è segnato anche nel riepilogo', async () => {
        const data = { ...before, events: [{ id: 't', start: '2026-11-10T09:00:00', end: '2026-11-10T12:00:00', title: 'Turno', extendedProps: { centerId: 'sport', externalRemovalPending: true } }], centers: [CENTERS[1]] };
        const deps = digestDeps({ loadData: vi.fn(async () => data) });
        await callDigest(deps);
        expect(digestText(deps)).toContain('• 09:00–12:00 – 🩺 Turno – Medicina dello Sport ❌ cancellato dal calendario originale');
        expect(digestText(deps)).toContain('❌ 1 appuntamento cancellato');
    });
});
