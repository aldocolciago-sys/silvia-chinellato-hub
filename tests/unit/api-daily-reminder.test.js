import { describe, it, expect, vi, beforeEach } from 'vitest';

// Firebase Admin simulato: Firestore in memoria e verifica dei token.
const admin = vi.hoisted(() => ({ docs: {}, collections: {}, writes: [], tokens: {}, initCalls: 0, apps: [] }));
vi.mock('firebase-admin/app', () => ({
    getApps: () => admin.apps,
    cert: (json) => { if (json.private_key === 'rotta') throw new Error('Failed to parse private key'); return { json }; },
    initializeApp: (options) => { admin.initCalls += 1; const app = { options }; admin.apps.push(app); return app; }
}));
vi.mock('firebase-admin/firestore', () => ({
    getFirestore: () => ({
        collection: (path) => ({ get: async () => ({ docs: (admin.collections[path] || []).map(([id, data]) => ({ id, data: () => data })) }) }),
        doc: (path) => ({
            get: async () => ({ exists: path in admin.docs, data: () => admin.docs[path] }),
            set: async (data, options) => { admin.writes.push({ path, data, options }); admin.docs[path] = { ...(admin.docs[path] || {}), ...data }; }
        })
    })
}));
// firebase-admin/auth non va mai caricato: su Vercel si rompe (jwks-rsa → jose ESM).
vi.mock('firebase-admin/auth', () => { throw new Error('firebase-admin/auth non deve essere importato'); });

import defaultHandler, {
    createHandler, realDeps, sendCallMeBot, firebaseAdmin, parseServiceAccount, lookupFirebaseUser, FIREBASE_WEB_API_KEY, TEST_COOLDOWN_MS
} from '../../api/daily-reminder.js';
import {
    buildDigest, commitmentsForDay, parseEventStart, romeDayKey, initials, appointmentsForDay, dayLabel, addDaysToKey, normalizeWhatsAppNumber, MAX_LINES_PER_DAY
} from '../../api/_daily-reminder-core.js';
import { createMockReq, createMockRes } from '../support/vercel-mock.js';

const ROOT = 'artifacts/silvia-chinellato-app/shared/data';
// Giovedì 1 ottobre 2026, 07:00 a Roma (ora legale, UTC+2).
const SEVEN_AM = new Date('2026-10-01T05:00:00Z');

const DATA = {
    events: [
        { id: 'a', start: '2026-10-01T09:00:00', title: 'Osteopatia', extendedProps: { patientId: 'p1', centerName: 'Studio Privato' } },
        { id: 'b', start: '2026-10-02T13:00:00Z', title: 'seduta', extendedProps: { patientId: 'p2', centerId: 'c1' } },
        { id: 'turno', start: '2026-10-02T08:00:00', title: 'Turno', extendedProps: { centerId: 'sport' } },
        { id: 'libero', start: '2026-10-02T12:00:00', title: 'Pranzo', extendedProps: { isNonClinical: true } },
        { id: 'annullato', start: '2026-10-02T11:00:00', title: 'Osteopatia', extendedProps: { patientId: 'p1', paymentStatus: 'cancelled' } },
        { id: 'giornata', start: '2026-10-02T09:00:00.000Z', allDay: true, title: 'Ferie' },
        { id: 'nuovo', start: '2026-10-02T10:00:00', title: 'Nuovo contatto' },
        { id: 'inviato', start: '2026-10-02T17:00:00', title: 'Osteopatia', extendedProps: { patientId: 'p1', reminderSentAt: '2026-10-01T16:00:00Z' } },
        { id: 'presto', start: '2026-10-01T06:30:00', title: 'Osteopatia', extendedProps: { patientId: 'p1' } },
        { id: 'dopodomani', start: '2026-10-03T09:00:00', title: 'Osteopatia', extendedProps: { patientId: 'p1' } },
        { id: 'rotto', start: 'non è una data', title: 'Osteopatia' }
    ],
    patients: [{ id: 'p1', name: 'Maria Rossi', phone: '333 1234567' }, { id: 'p2', name: "Anna D'Amico", phone: '' }],
    centers: [{ id: 'c1', name: 'CMS Carate', service: 'Idrocolonterapia' }, { id: 'sport', name: 'Medicina dello Sport', isNonClinicalCalendar: true, isShiftCalendar: true }]
};

const SERVICE_ACCOUNT = { project_id: 'x', client_email: 'bot@x.iam.gserviceaccount.com', private_key: 'chiave' };
const ENV = { CRON_SECRET: 'segreto-cron', CALLMEBOT_PHONE: '+393331112222', CALLMEBOT_APIKEY: 'chiave123', FIREBASE_SERVICE_ACCOUNT: JSON.stringify(SERVICE_ACCOUNT), APP_URL: 'https://agenda.example' };

function okResponse(body = 'Message queued. You will receive it in a few seconds.', status = 200) {
    return { ok: status < 400, status, text: async () => body };
}

function makeDeps(overrides = {}) {
    const deps = {
        env: { ...ENV },
        now: () => SEVEN_AM,
        fetch: vi.fn(async () => okResponse()),
        verifyUser: vi.fn(async (token) => {
            if (token === 'token-silvia') return { email: 'SilviaChine@gmail.com', email_verified: true };
            if (token === 'token-intruso') return { email: 'intruso@example.com', email_verified: true };
            if (token === 'token-non-verificato') return { email: 'silviachine@gmail.com', email_verified: false };
            throw Object.assign(new Error('Decoding Firebase ID token failed.'), { code: 'auth/argument-error' });
        }),
        loadData: vi.fn(async () => ({ ...DATA, messagingSettings: { dailyDigestEnabled: true }, status: null })),
        saveStatus: vi.fn(async () => {}),
        ...overrides
    };
    return deps;
}

async function call(deps, { method = 'GET', token = 'segreto-cron', query = {}, headers = {} } = {}) {
    const res = createMockRes();
    await createHandler(deps)(createMockReq({ method, query, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } }), res);
    return res;
}

function sentText(deps) {
    return new URL(deps.fetch.mock.calls.at(-1)[0]).searchParams.get('text');
}

beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('riepilogo WhatsApp – orari di Roma', () => {
    it('legge gli orari senza fuso come ora di Roma, con ora legale e solare', () => {
        expect(parseEventStart('2026-10-01T09:00:00').toISOString()).toBe('2026-10-01T07:00:00.000Z');
        expect(parseEventStart('2026-12-01T09:00').toISOString()).toBe('2026-12-01T08:00:00.000Z');
        expect(parseEventStart('2026-10-01T09:00:00.000Z').toISOString()).toBe('2026-10-01T09:00:00.000Z');
        expect(parseEventStart('2026-10-01T09:00:00+02:00').toISOString()).toBe('2026-10-01T07:00:00.000Z');
        // giorni del cambio d'ora
        expect(parseEventStart('2026-03-29T09:00:00').toISOString()).toBe('2026-03-29T07:00:00.000Z');
        expect(parseEventStart('2026-10-25T09:00:00').toISOString()).toBe('2026-10-25T08:00:00.000Z');
        expect(parseEventStart('')).toBeNull();
        expect(parseEventStart('boh')).toBeNull();
    });

    it('calcola il giorno di Roma anche a cavallo della mezzanotte UTC', () => {
        expect(romeDayKey(new Date('2026-09-30T22:30:00Z'))).toBe('2026-10-01');
        expect(romeDayKey(new Date('2026-12-31T23:30:00Z'))).toBe('2027-01-01');
        expect(addDaysToKey('2026-12-31', 1)).toBe('2027-01-01');
        expect(addDaysToKey('2028-02-28', 1)).toBe('2028-02-29');
        expect(dayLabel('2026-10-01')).toBe('giovedì 1 ottobre');
    });

    it('usa solo le iniziali dei pazienti', () => {
        expect(initials('Maria Rossi')).toBe('M.R.');
        expect(initials("Anna D'Amico")).toBe('A.D.');
        expect(initials('  émile   zola-bianchi ')).toBe('É.Z.B.');
        expect(initials('')).toBe('?');
    });

    it('riconosce i numeri di telefono come l\'app', () => {
        expect(normalizeWhatsAppNumber('333 1234567')).toBe('393331234567');
        expect(normalizeWhatsAppNumber('+39 333 1234567')).toBe('393331234567');
        expect(normalizeWhatsAppNumber('0039 333 1234567')).toBe('393331234567');
        expect(normalizeWhatsAppNumber('12')).toBe('');
        expect(normalizeWhatsAppNumber('')).toBe('');
    });
});

describe('riepilogo WhatsApp – contenuto', () => {
    it('elenca oggi e domani come la finestra Promemoria', () => {
        const tomorrow = appointmentsForDay(DATA, '2026-10-02');
        expect(tomorrow.map(item => item.time)).toEqual(['10:00', '15:00', '17:00']);
        expect(tomorrow[1]).toMatchObject({ who: 'A.D.', treatment: 'Idrocolonterapia', place: 'CMS Carate', hasPhone: false });
        expect(tomorrow[0]).toMatchObject({ who: 'senza paziente', treatment: null, place: 'studio', hasPatient: false });
    });

    it('compone il testo con iniziali, trattamento, sede e cose da fare', () => {
        const { text, todayKey, counts } = buildDigest(DATA, SEVEN_AM, { appUrl: 'https://agenda.example' });
        expect(todayKey).toBe('2026-10-01');
        expect(counts).toEqual({ today: 1, tomorrow: 3, shifts: 1, personal: 2, pending: 1, noPhone: 1, noPatient: 1 });
        expect(text).toBe([
            '☀️ Buongiorno Silvia! Oggi è giovedì 1 ottobre.',
            '',
            '*Oggi* (1)',
            '• 09:00 – M.R. – Osteopatia – studio',
            '',
            '*Domani, venerdì 2 ottobre* (6)',
            '• Tutto il giorno – 🗓️ Ferie',
            '• 08:00 – 🩺 Turno – Medicina dello Sport',
            '• 10:00 – senza paziente – studio',
            '• 12:00 – 🗓️ Pranzo',
            '• 15:00 – A.D. – Idrocolonterapia – CMS Carate ⚠️ senza telefono',
            '• 17:00 – M.R. – Osteopatia – studio',
            '',
            '📲 1 promemoria da inviare ai pazienti',
            '⚠️ 1 paziente senza telefono',
            '⚠️ 1 appuntamento senza paziente associato',
            '',
            "Apri l'agenda: https://agenda.example"
        ].join('\n'));
        expect(text).not.toMatch(/Maria|Rossi|Anna|Amico/);
    });

    it('giornate vuote, messaggio di prova e plurali', () => {
        const { text } = buildDigest({}, SEVEN_AM, { test: true });
        expect(text.split('\n').slice(0, 2)).toEqual(['🧪 Messaggio di prova', '']);
        expect(text).toContain('*Oggi*: nessun impegno in agenda.');
        expect(text).toContain('*Domani, venerdì 2 ottobre*: nessun impegno in agenda.');
        expect(text).not.toContain('Apri l\'agenda');
        const two = buildDigest({ events: [DATA.events[6], { ...DATA.events[6], id: 'n2', start: '2026-10-02T11:00:00' }] }, SEVEN_AM);
        expect(two.text).toContain('⚠️ 2 appuntamenti senza paziente associato');
        const noPhones = buildDigest({ ...DATA, patients: [{ id: 'p1', name: 'Maria Rossi' }, DATA.patients[1]] }, SEVEN_AM);
        expect(noPhones.text).toContain('⚠️ 3 pazienti senza telefono');
    });

    it('include turni, calendari personali e giornate intere', () => {
        const centers = [
            { id: 'sport', name: 'Medicina dello Sport', isNonClinicalCalendar: true, isShiftCalendar: true },
            { id: 'pers', name: 'Personale', isNonClinicalCalendar: true },
            { id: 'cms', name: 'CMS Carate' }
        ];
        const events = [
            { id: 'turno', start: '2026-10-01T06:00:00', end: '2026-10-01T13:00:00', title: 'Turno', extendedProps: { centerId: 'sport' } },
            { id: 'finito', start: '2026-10-01T05:00:00', end: '2026-10-01T06:30:00', title: 'Corsa', extendedProps: { centerId: 'pers' } },
            { id: 'corso', start: '2026-09-30T09:00:00.000Z', end: '2026-10-03T09:00:00.000Z', allDay: true, title: 'Corso **ECM**', extendedProps: { centerId: 'pers' } },
            { id: 'chiuso', start: '2026-10-01T09:00:00.000Z', allDay: true, title: 'Studio chiuso', extendedProps: { centerId: 'cms' } },
            { id: 'annullato', start: '2026-10-01T18:00:00', title: 'Cena', extendedProps: { centerId: 'pers', paymentStatus: 'cancelled' } },
            { id: 'lungo', start: '2026-10-01T20:00:00', end: '2026-10-01T19:00:00', title: 'x'.repeat(80), extendedProps: { isNonClinical: true } },
            { id: 'senza-titolo', start: '2026-10-01T21:00:00', title: '  ', extendedProps: { centerId: 'pers' } },
            { id: 'paziente', start: '2026-10-01T10:00:00', title: 'Osteopatia', extendedProps: { centerId: 'cms' } }
        ];
        const today = commitmentsForDay({ events, centers }, '2026-10-01', SEVEN_AM);
        expect(today.map(item => `${item.time} | ${item.kind} | ${item.label} | ${item.place}`)).toEqual([
            'Tutto il giorno | personal | Corso ECM | ',
            'Tutto il giorno | personal | Studio chiuso | ',
            '06:00–13:00 | shift | Turno | Medicina dello Sport', // già iniziato ma non finito
            `20:00 | personal | ${'x'.repeat(59)}… | `, // fine prima dell'inizio: solo l'ora d'inizio
            '21:00 | personal | Impegno personale | '
        ]);
        expect(commitmentsForDay({ events, centers }, '2026-10-02').map(item => item.label)).toEqual(['Corso ECM']);
        expect(commitmentsForDay({ events, centers }, '2026-10-03')).toEqual([]);
        const { text, counts } = buildDigest({ events, centers }, SEVEN_AM);
        expect(text).toContain('*Oggi* (6)\n• Tutto il giorno – 🗓️ Corso ECM\n• Tutto il giorno – 🗓️ Studio chiuso\n• 06:00–13:00 – 🩺 Turno – Medicina dello Sport\n• 10:00 – senza paziente – Osteopatia – CMS Carate\n');
        expect(counts).toMatchObject({ today: 1, shifts: 1, personal: 5 });
    });

    it('tronca le giornate molto piene', () => {
        const events = Array.from({ length: MAX_LINES_PER_DAY + 3 }, (_, i) => ({ id: `e${i}`, start: `2026-10-02T${String(8 + Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}:00`, title: 'Osteopatia' }));
        const { text } = buildDigest({ events }, SEVEN_AM);
        expect(text).toContain('…e altri 3');
        expect(text.split('\n').filter(line => line.startsWith('• '))).toHaveLength(MAX_LINES_PER_DAY);
    });
});

describe('api/daily-reminder – invio programmato (GET)', () => {
    it('invia il riepilogo con CallMeBot e salva lo stato', async () => {
        const deps = makeDeps();
        const res = await call(deps);
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ status: 'sent', counts: { today: 1, tomorrow: 3, shifts: 1, personal: 2, pending: 1, noPhone: 1, noPatient: 1 } });
        expect(res.headers['cache-control']).toBe('no-store');
        const url = new URL(deps.fetch.mock.calls[0][0]);
        expect(url.origin + url.pathname).toBe('https://api.callmebot.com/whatsapp.php');
        expect(url.searchParams.get('phone')).toBe('+393331112222');
        expect(url.searchParams.get('apikey')).toBe('chiave123');
        expect(sentText(deps)).toContain('• 09:00 – M.R. – Osteopatia – studio');
        expect(deps.saveStatus).toHaveBeenCalledWith({ lastSentDay: '2026-10-01', lastSentAt: SEVEN_AM.toISOString(), lastCounts: expect.any(Object), lastError: null });
    });

    it('accetta solo il segreto del cron', async () => {
        for (const token of [null, 'sbagliato', 'segreto-cro']) {
            const res = await call(makeDeps(), { token });
            expect(res.statusCode).toBe(401);
        }
        const res = await call(makeDeps({ env: { ...ENV, CRON_SECRET: '' } }));
        expect(res.statusCode).toBe(401);
        const wrongScheme = await call(makeDeps(), { token: null, headers: { authorization: 'Basic segreto-cron' } });
        expect(wrongScheme.statusCode).toBe(401);
    });

    it('rifiuta gli altri metodi', async () => {
        const res = await call(makeDeps(), { method: 'DELETE' });
        expect(res.statusCode).toBe(405);
        expect(res.headers.allow).toBe('GET, POST');
    });

    it('segnala la configurazione mancante senza inviare', async () => {
        const deps = makeDeps({ env: { CRON_SECRET: 'segreto-cron', CALLMEBOT_PHONE: '+39333' } });
        const res = await call(deps);
        expect(res.statusCode).toBe(500);
        expect(res.body.error).toBe('Configurazione mancante su Vercel: CALLMEBOT_APIKEY, FIREBASE_SERVICE_ACCOUNT');
        expect(deps.fetch).not.toHaveBeenCalled();
    });

    it('in inverno la chiamata delle 6:00 UTC (7:00 a Roma) invia, quella delle 5:00 aspetta', async () => {
        const early = makeDeps({ now: () => new Date('2026-12-01T05:00:00Z') });
        expect((await call(early)).body).toEqual({ status: 'skipped', reason: 'Non sono ancora le 7 a Roma' });
        expect(early.loadData).not.toHaveBeenCalled();
        const onTime = makeDeps({ now: () => new Date('2026-12-01T06:00:00Z') });
        expect((await call(onTime)).body.status).toBe('sent');
    });

    it('con ?force=1 invia anche prima delle 7 e anche se già inviato', async () => {
        const deps = makeDeps({
            now: () => new Date('2026-12-01T05:00:00Z'),
            loadData: async () => ({ ...DATA, messagingSettings: { dailyDigestEnabled: true }, status: { lastSentDay: '2026-12-01' } })
        });
        expect((await call(deps, { query: { force: '1' } })).body.status).toBe('sent');
    });

    it('non invia se disattivato nell\'app o già inviato oggi', async () => {
        const off = makeDeps({ loadData: async () => ({ ...DATA, messagingSettings: null, status: null }) });
        expect((await call(off)).body).toEqual({ status: 'skipped', reason: 'Invio automatico disattivato nell\'app' });
        const done = makeDeps({ loadData: async () => ({ ...DATA, messagingSettings: { dailyDigestEnabled: true }, status: { lastSentDay: '2026-10-01' } }) });
        expect((await call(done)).body).toEqual({ status: 'skipped', reason: 'Riepilogo di oggi già inviato' });
        expect(off.fetch).not.toHaveBeenCalled();
        expect(done.fetch).not.toHaveBeenCalled();
    });

    it('usa l\'indirizzo della richiesta se APP_URL non è impostato', async () => {
        const deps = makeDeps({ env: { ...ENV, APP_URL: '' } });
        await call(deps, { headers: { host: 'silvia.vercel.app' } });
        expect(sentText(deps)).toContain("Apri l'agenda: https://silvia.vercel.app");
        const forwarded = makeDeps({ env: { ...ENV, APP_URL: '' } });
        await call(forwarded, { headers: { 'x-forwarded-host': 'agenda.silvia.it', host: 'interno' } });
        expect(sentText(forwarded)).toContain('https://agenda.silvia.it');
        const none = makeDeps({ env: { ...ENV, APP_URL: '' } });
        await call(none);
        expect(sentText(none)).not.toContain('Apri l\'agenda');
    });

    it('errore di lettura dei dati', async () => {
        const deps = makeDeps({ loadData: async () => { throw new Error('permesso negato'); } });
        const res = await call(deps);
        expect(res.statusCode).toBe(500);
        expect(res.body.error).toBe('Lettura dei dati non riuscita');
        expect(deps.fetch).not.toHaveBeenCalled();
    });

    it('se CallMeBot rifiuta registra l\'errore e il giorno resta da inviare', async () => {
        const deps = makeDeps({ fetch: vi.fn(async () => okResponse('<p>APIKey is invalid. You need to get a new one</p>')) });
        const res = await call(deps);
        expect(res.statusCode).toBe(502);
        expect(res.body.error).toBe('CallMeBot ha rifiutato il messaggio (HTTP 200): APIKey is invalid. You need to get a new one');
        expect(deps.saveStatus).toHaveBeenCalledWith({ lastErrorAt: SEVEN_AM.toISOString(), lastError: res.body.error });
        expect(deps.saveStatus.mock.calls[0][0]).not.toHaveProperty('lastSentDay');
    });

    it('un errore nel salvare lo stato dopo un invio fallito non nasconde l\'errore', async () => {
        const deps = makeDeps({ fetch: vi.fn(async () => okResponse('Errore', 503)), saveStatus: vi.fn(async () => { throw new Error('offline'); }) });
        const res = await call(deps);
        expect(res.statusCode).toBe(502);
        expect(res.body.error).toBe('CallMeBot ha rifiutato il messaggio (HTTP 503): Errore');
    });
});

describe('api/daily-reminder – prova dall\'app (POST)', () => {
    it('un account autorizzato invia una prova, a qualunque ora', async () => {
        const deps = makeDeps({ now: () => new Date('2026-10-01T03:00:00Z'), loadData: async () => ({ ...DATA, messagingSettings: null, status: { lastSentDay: '2026-10-01' } }) });
        const res = await call(deps, { method: 'POST', token: 'token-silvia' });
        expect(res.statusCode).toBe(200);
        expect(sentText(deps)).toMatch(/^🧪 Messaggio di prova/);
        expect(deps.saveStatus).toHaveBeenCalledWith({ lastTestAt: '2026-10-01T03:00:00.000Z', lastError: null });
    });

    it('richiede un token valido di un account autorizzato e verificato', async () => {
        expect((await call(makeDeps(), { method: 'POST', token: null })).statusCode).toBe(401);
        expect((await call(makeDeps(), { method: 'POST', token: 'scaduto' })).statusCode).toBe(401);
        expect((await call(makeDeps(), { method: 'POST', token: 'token-intruso' })).statusCode).toBe(403);
        expect((await call(makeDeps(), { method: 'POST', token: 'token-non-verificato' })).statusCode).toBe(403);
        // il segreto del cron non vale come accesso dall'app
        expect((await call(makeDeps(), { method: 'POST', token: 'segreto-cron' })).statusCode).toBe(401);
        const expired = await call(makeDeps(), { method: 'POST', token: 'scaduto' });
        expect(expired.body.error).toBe("Sessione non valida (auth/argument-error): esci e rientra nell'area riservata.");
    });

    it('distingue configurazione, sessione e servizio di verifica', async () => {
        // chiave mancante (o vuota): lo dice prima ancora di verificare il token
        const missing = makeDeps({ env: { ...ENV, FIREBASE_SERVICE_ACCOUNT: '  ' } });
        const res1 = await call(missing, { method: 'POST', token: 'token-silvia' });
        expect(res1.statusCode).toBe(500);
        expect(res1.body.error).toBe('Configurazione mancante su Vercel: FIREBASE_SERVICE_ACCOUNT');
        expect(missing.verifyUser).not.toHaveBeenCalled();
        // il servizio di verifica non risponde: non è colpa della sessione
        const down = makeDeps({ verifyUser: vi.fn(async () => { throw new Error('Identity Toolkit non raggiungibile'); }) });
        const res2 = await call(down, { method: 'POST', token: 'token-silvia' });
        expect(res2.statusCode).toBe(502);
        expect(res2.body.error).toBe("Verifica dell'accesso non riuscita: riprova tra qualche minuto.");
        const noCode = makeDeps({ verifyUser: vi.fn(async () => { throw null; }) });
        expect((await call(noCode, { method: 'POST', token: 'token-silvia' })).statusCode).toBe(502);
        // chiave di servizio rotta: lo dice la lettura dei dati, con il motivo
        const broken = makeDeps({ loadData: vi.fn(async () => { throw Object.assign(new Error('La chiave FIREBASE_SERVICE_ACCOUNT su Vercel non è un JSON valido: …'), { code: 'config/service-account' }); }) });
        const res3 = await call(broken, { method: 'POST', token: 'token-silvia' });
        expect(res3.statusCode).toBe(500);
        expect(res3.body.error).toBe('La chiave FIREBASE_SERVICE_ACCOUNT su Vercel non è un JSON valido: …');
    });

    it('al massimo una prova al minuto', async () => {
        const recent = new Date(SEVEN_AM.getTime() - TEST_COOLDOWN_MS + 1000).toISOString();
        const deps = makeDeps({ loadData: async () => ({ ...DATA, status: { lastTestAt: recent } }) });
        const res = await call(deps, { method: 'POST', token: 'token-silvia' });
        expect(res.statusCode).toBe(429);
        expect(deps.fetch).not.toHaveBeenCalled();
        const old = new Date(SEVEN_AM.getTime() - TEST_COOLDOWN_MS).toISOString();
        const ok = makeDeps({ loadData: async () => ({ ...DATA, status: { lastTestAt: old } }) });
        expect((await call(ok, { method: 'POST', token: 'token-silvia' })).statusCode).toBe(200);
    });

    it('una prova fallita registra l\'errore e l\'ora della prova', async () => {
        const deps = makeDeps({ fetch: vi.fn(async () => { throw new TypeError('fetch failed'); }) });
        const res = await call(deps, { method: 'POST', token: 'token-silvia' });
        expect(res.statusCode).toBe(502);
        expect(res.body.error).toBe('CallMeBot non raggiungibile (errore di rete)');
        expect(deps.saveStatus).toHaveBeenCalledWith({ lastErrorAt: SEVEN_AM.toISOString(), lastError: res.body.error, lastTestAt: SEVEN_AM.toISOString() });
    });
});

describe('lookupFirebaseUser', () => {
    const lookup = (response) => lookupFirebaseUser('tok', { apiKey: 'k', fetchImpl: async () => response });
    const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });

    it('traduce le risposte di Google', async () => {
        await expect(lookup(reply(200, { users: [{ email: 'a@b.it' }] }))).resolves.toEqual({ email: 'a@b.it', email_verified: false });
        await expect(lookup(reply(200, { users: [{}] }))).resolves.toEqual({ email: '', email_verified: false });
        await expect(lookup(reply(200, {}))).rejects.toMatchObject({ code: 'auth/user-not-found' });
        await expect(lookup(reply(400, { error: { message: 'INVALID_ID_TOKEN' } }))).rejects.toMatchObject({ code: 'auth/invalid-id-token' });
        await expect(lookup(reply(400, { error: { message: 'TOKEN_EXPIRED' } }))).rejects.toMatchObject({ code: 'auth/token-expired' });
        const other = await lookup(reply(400, { error: { message: 'API key not valid' } })).catch(e => e);
        expect(other.code).toBeUndefined();
        expect(other.message).toBe('Identity Toolkit HTTP 400 API key not valid');
        const down = await lookup({ ok: false, status: 503, json: async () => { throw new Error('html'); } }).catch(e => e);
        expect(down.message).toBe('Identity Toolkit HTTP 503');
        await expect(lookupFirebaseUser('tok', { apiKey: 'k', fetchImpl: async () => { throw new TypeError('fetch failed'); } }))
            .rejects.toThrow('Identity Toolkit non raggiungibile');
    });
});

describe('parseServiceAccount', () => {
    it('accetta la chiave completa, anche con spazi intorno', () => {
        expect(parseServiceAccount(`  ${JSON.stringify(SERVICE_ACCOUNT)}\n`)).toEqual(SERVICE_ACCOUNT);
    });
    it('spiega cosa non va senza mostrare la chiave', () => {
        const err = (raw) => { try { parseServiceAccount(raw); } catch (e) { return e; } };
        expect(err('{"private_key":"SEGRETO"')).toMatchObject({ code: 'config/service-account', message: "La chiave FIREBASE_SERVICE_ACCOUNT su Vercel non è un JSON valido: incolla di nuovo l'intero contenuto del file JSON e rifai il deploy." });
        expect(err('{"private_key":"SEGRETO"').message).not.toContain('SEGRETO');
        expect(err(undefined).message).toContain('non è un JSON valido');
        expect(err('null').message).toContain('non contiene project_id, client_email, private_key');
        expect(err(JSON.stringify({ private_key: 'SEGRETO' })).message).toContain('non contiene project_id, client_email:');
    });
});

describe('sendCallMeBot', () => {
    it('distingue il tempo scaduto e non espone la chiave', async () => {
        const timeout = Object.assign(new Error('scaduto'), { name: 'TimeoutError' });
        await expect(sendCallMeBot('ciao', { phone: '+39', apiKey: 'segreta', fetchImpl: async () => { throw timeout; } }))
            .rejects.toThrow('CallMeBot non raggiungibile (tempo scaduto)');
        const err = await sendCallMeBot('ciao', { phone: '+39', apiKey: 'segreta', fetchImpl: async () => okResponse('no', 400) }).catch(e => e);
        expect(err.message).not.toContain('segreta');
    });

    it('restituisce la risposta ripulita', async () => {
        await expect(sendCallMeBot('ciao', { phone: '+39', apiKey: 'k', fetchImpl: async () => okResponse('<b>Message queued</b>\n ok') }))
            .resolves.toBe('Message queued ok');
    });
});

describe('api/daily-reminder – Firebase Admin', () => {
    beforeEach(() => {
        Object.assign(admin, { docs: {}, collections: {}, writes: [], tokens: {}, initCalls: 0, apps: [] });
    });

    // primo test del gruppo: Firebase Admin non è ancora inizializzato
    it('una chiave con private_key rotta dà un errore chiaro e si può riprovare', async () => {
        const broken = JSON.stringify({ ...SERVICE_ACCOUNT, private_key: 'rotta' });
        await expect(realDeps({ ...ENV, FIREBASE_SERVICE_ACCOUNT: broken }).loadData())
            .rejects.toMatchObject({ code: 'config/service-account', message: expect.stringContaining('ha una private_key non valida') });
        await expect(realDeps({ ...ENV, FIREBASE_SERVICE_ACCOUNT: 'non json' }).saveStatus({}))
            .rejects.toMatchObject({ code: 'config/service-account' });
        expect(admin.initCalls).toBe(0);
    });

    it('legge pazienti, appuntamenti, sedi e impostazioni condivise', async () => {
        admin.collections[`${ROOT}/studio_events`] = [['a', DATA.events[0]]];
        admin.collections[`${ROOT}/patients_list`] = [['doc-p1', { name: 'Maria Rossi' }], ['doc-x', { id: 'p2', name: 'Anna' }]];
        admin.collections[`${ROOT}/centers_list`] = [['c1', DATA.centers[0]]];
        admin.docs[`${ROOT}/settings/messaging`] = { dailyDigestEnabled: true };
        const data = await realDeps({ ...ENV }).loadData();
        expect(data).toEqual({
            events: [DATA.events[0]],
            patients: [{ id: 'doc-p1', name: 'Maria Rossi' }, { id: 'p2', name: 'Anna' }],
            centers: [DATA.centers[0]],
            messagingSettings: { dailyDigestEnabled: true },
            status: null
        });
        expect(admin.apps[0].options.credential).toEqual({ json: SERVICE_ACCOUNT });
    });

    it('salva lo stato nel documento condiviso (APP_ID configurabile)', async () => {
        await realDeps({ ...ENV, APP_ID: 'altra-app' }).saveStatus({ lastSentDay: '2026-10-01' });
        expect(admin.writes[0]).toMatchObject({ path: 'artifacts/altra-app/shared/data/settings/daily_reminder', data: { lastSentDay: '2026-10-01', updatedAt: expect.any(String) }, options: { merge: true } });
        expect(admin.docs['artifacts/altra-app/shared/data/settings/daily_reminder'].lastSentDay).toBe('2026-10-01');
    });

    it('inizializza Admin una sola volta e solo con app e Firestore', async () => {
        await firebaseAdmin({ ...ENV });
        await firebaseAdmin({ ...ENV });
        expect(admin.initCalls).toBeLessThanOrEqual(1);
    });

    it('verifica il token con Identity Toolkit e la chiave web pubblica', async () => {
        const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ users: [{ email: 'silviachine@gmail.com', emailVerified: true }] }) }));
        vi.stubGlobal('fetch', fetchMock);
        await expect(realDeps({ ...ENV }).verifyUser('tok')).resolves.toEqual({ email: 'silviachine@gmail.com', email_verified: true });
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_WEB_API_KEY}`);
        expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ idToken: 'tok' }) });
        await realDeps({ ...ENV, FIREBASE_WEB_API_KEY: 'altra' }).verifyUser('tok');
        expect(fetchMock.mock.calls[1][0]).toContain('key=altra');
        vi.unstubAllGlobals();
    });
    it('dipendenze reali: orologio e fetch', async () => {
        const deps = realDeps({});
        expect(Math.abs(deps.now() - Date.now())).toBeLessThan(1000);
        const fetchMock = vi.fn(async () => 'risposta');
        vi.stubGlobal('fetch', fetchMock);
        await expect(deps.fetch('https://x')).resolves.toBe('risposta');
        vi.unstubAllGlobals();
    });

    it('il gestore predefinito è pronto all\'uso', async () => {
        const res = createMockRes();
        await defaultHandler(createMockReq({ method: 'GET', headers: {} }), res);
        expect(res.statusCode).toBe(401);
    });
});
