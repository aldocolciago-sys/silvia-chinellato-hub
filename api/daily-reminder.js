import { timingSafeEqual } from 'node:crypto';
import { buildDigest, romeParts, SEND_FROM_HOUR } from './_daily-reminder-core.js';

/**
 * Riepilogo mattutino su WhatsApp (CallMeBot) per Silvia.
 *
 * GET  – chiamata dal cron di Vercel con `Authorization: Bearer <CRON_SECRET>`.
 *        Invia al massimo una volta al giorno, dalle 7:00 (ora di Roma), solo se
 *        l'invio automatico è attivo nell'app (settings/messaging.dailyDigestEnabled).
 * POST – "Invia una prova ora" dall'app, con il token Firebase di un account autorizzato.
 *
 * Variabili d'ambiente: CALLMEBOT_PHONE, CALLMEBOT_APIKEY, CRON_SECRET,
 * FIREBASE_SERVICE_ACCOUNT (JSON della chiave), facoltative APP_URL, APP_ID e FIREBASE_WEB_API_KEY.
 */
export const AUTHORIZED_EMAILS = ['silviachine@gmail.com', 'aldo.colciago@gmail.com'];
export const TEST_COOLDOWN_MS = 60000;
const CALLMEBOT_URL = 'https://api.callmebot.com/whatsapp.php';
const IDENTITY_TOOLKIT_URL = 'https://identitytoolkit.googleapis.com/v1/accounts:lookup';
/** Chiave web pubblica del progetto Firebase (la stessa di index.html, non è un segreto). */
export const FIREBASE_WEB_API_KEY = 'AIzaSyBzrgpVFTVcdhGKawwjFPvxlkTs2iD6Xe8';
const TIMEOUT_MS = 20000;

function bearerToken(req) {
    const header = String(req.headers?.authorization || '');
    return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

function safeEqual(a, b) {
    const left = Buffer.from(String(a));
    const right = Buffer.from(String(b));
    return left.length === right.length && timingSafeEqual(left, right);
}

function missingConfig(env) {
    return ['CALLMEBOT_PHONE', 'CALLMEBOT_APIKEY', 'FIREBASE_SERVICE_ACCOUNT'].filter(name => !String(env[name] || '').trim());
}

function appUrl(req, env) {
    if (env.APP_URL) return env.APP_URL;
    const host = req.headers?.['x-forwarded-host'] || req.headers?.host;
    return host ? `https://${host}` : '';
}

/** Invia il testo con CallMeBot. La chiave non finisce mai nei messaggi d'errore. */
export async function sendCallMeBot(text, { phone, apiKey, fetchImpl }) {
    const url = `${CALLMEBOT_URL}?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(apiKey)}`;
    let response;
    try {
        response = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
        throw new Error(`CallMeBot non raggiungibile (${err.name === 'TimeoutError' ? 'tempo scaduto' : 'errore di rete'})`);
    }
    const body = String(await response.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!response.ok || (/apikey/i.test(body) && /invalid|wrong|not valid/i.test(body))) {
        throw new Error(`CallMeBot ha rifiutato il messaggio (HTTP ${response.status}): ${body.slice(0, 160)}`);
    }
    return body.slice(0, 160);
}

export function createHandler(deps) {
    return async function handler(req, res) {
        res.setHeader('Cache-Control', 'no-store');
        if (req.method !== 'GET' && req.method !== 'POST') {
            res.setHeader('Allow', 'GET, POST');
            return res.status(405).json({ error: 'Metodo non consentito' });
        }
        const env = deps.env;
        const isTest = req.method === 'POST';
        const token = bearerToken(req);

        if (!isTest) {
            if (!env.CRON_SECRET || !token || !safeEqual(token, env.CRON_SECRET)) return res.status(401).json({ error: 'Non autorizzato' });
        } else {
            if (!token) return res.status(401).json({ error: 'Accesso richiesto' });
            const missing = missingConfig(env);
            if (missing.length) return res.status(500).json({ error: `Configurazione mancante su Vercel: ${missing.join(', ')}` });
            let user;
            try {
                user = await deps.verifyUser(token);
            } catch (err) {
                const code = String(err?.code || '');
                if (code.startsWith('auth/')) {
                    console.error('Riepilogo WhatsApp: token rifiutato', code);
                    return res.status(401).json({ error: `Sessione non valida (${code}): esci e rientra nell'area riservata.` });
                }
                console.error('Riepilogo WhatsApp: verifica dell\'accesso non riuscita', err?.message);
                return res.status(502).json({ error: 'Verifica dell\'accesso non riuscita: riprova tra qualche minuto.' });
            }
            const email = String(user?.email || '').toLowerCase();
            if (!user?.email_verified || !AUTHORIZED_EMAILS.includes(email)) return res.status(403).json({ error: 'Account non autorizzato' });
        }

        const missing = missingConfig(env);
        if (missing.length) return res.status(500).json({ error: `Configurazione mancante su Vercel: ${missing.join(', ')}` });

        const now = deps.now();
        const force = !isTest && String(req.query?.force || '') === '1';
        if (!isTest && !force && romeParts(now).hour < SEND_FROM_HOUR) {
            return res.status(200).json({ status: 'skipped', reason: 'Non sono ancora le 7 a Roma' });
        }

        let data;
        try {
            data = await deps.loadData();
        } catch (err) {
            console.error('Riepilogo WhatsApp: lettura dati non riuscita', err?.message);
            return res.status(500).json({ error: err?.code === 'config/service-account' ? err.message : 'Lettura dei dati non riuscita' });
        }
        const status = data.status || {};
        if (!isTest && data.messagingSettings?.dailyDigestEnabled !== true) {
            return res.status(200).json({ status: 'skipped', reason: 'Invio automatico disattivato nell\'app' });
        }
        if (isTest && status.lastTestAt && now - new Date(status.lastTestAt) < TEST_COOLDOWN_MS) {
            return res.status(429).json({ error: 'Attendi un minuto prima di inviare un\'altra prova.' });
        }

        const digest = buildDigest(data, now, { appUrl: appUrl(req, env), test: isTest });
        if (!isTest && !force && status.lastSentDay === digest.todayKey) {
            return res.status(200).json({ status: 'skipped', reason: 'Riepilogo di oggi già inviato' });
        }

        const nowIso = now.toISOString();
        try {
            await sendCallMeBot(digest.text, { phone: env.CALLMEBOT_PHONE, apiKey: env.CALLMEBOT_APIKEY, fetchImpl: deps.fetch });
        } catch (err) {
            console.error('Riepilogo WhatsApp non inviato:', err.message);
            await deps.saveStatus({ lastErrorAt: nowIso, lastError: err.message, ...(isTest ? { lastTestAt: nowIso } : {}) }).catch(() => {});
            return res.status(502).json({ error: err.message });
        }
        await deps.saveStatus(isTest
            ? { lastTestAt: nowIso, lastError: null }
            : { lastSentDay: digest.todayKey, lastSentAt: nowIso, lastCounts: digest.counts, lastError: null });
        return res.status(200).json({ status: 'sent', counts: digest.counts });
    };
}

/** Legge la chiave di servizio; gli errori non riportano mai il contenuto della chiave. */
export function parseServiceAccount(raw) {
    const fail = (reason) => Object.assign(new Error(`La chiave FIREBASE_SERVICE_ACCOUNT su Vercel ${reason}: incolla di nuovo l'intero contenuto del file JSON e rifai il deploy.`), { code: 'config/service-account' });
    let json;
    try {
        json = JSON.parse(String(raw || '').trim());
    } catch {
        throw fail('non è un JSON valido');
    }
    const missing = ['project_id', 'client_email', 'private_key'].filter(key => !json?.[key]);
    if (missing.length) throw fail(`non contiene ${missing.join(', ')}`);
    return json;
}

let adminPromise = null;
/** Firebase Admin (solo app e Firestore), inizializzato una sola volta per istanza. */
export function firebaseAdmin(env = process.env) {
    adminPromise ??= (async () => {
        const serviceAccount = parseServiceAccount(env.FIREBASE_SERVICE_ACCOUNT);
        const [{ initializeApp, getApps, cert }, { getFirestore }] = await Promise.all([
            import('firebase-admin/app'), import('firebase-admin/firestore')
        ]);
        let credential;
        try {
            credential = cert(serviceAccount);
        } catch {
            throw Object.assign(new Error("La chiave FIREBASE_SERVICE_ACCOUNT su Vercel ha una private_key non valida: incolla di nuovo l'intero contenuto del file JSON e rifai il deploy."), { code: 'config/service-account' });
        }
        const app = getApps()[0] || initializeApp({ credential });
        return { db: getFirestore(app) };
    })();
    adminPromise.catch(() => { adminPromise = null; });
    return adminPromise;
}

/**
 * Verifica il token Firebase dell'utente con Identity Toolkit (Google), usando la chiave web
 * pubblica dell'app. Evita firebase-admin/auth, che su Vercel non si carica (jwks-rsa → jose ESM).
 */
export async function lookupFirebaseUser(token, { apiKey, fetchImpl }) {
    let response;
    try {
        response = await fetchImpl(`${IDENTITY_TOOLKIT_URL}?key=${encodeURIComponent(apiKey)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idToken: token }),
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
    } catch {
        throw new Error('Identity Toolkit non raggiungibile');
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        const reason = String(body?.error?.message || '');
        if (response.status === 400 && /TOKEN|USER_NOT_FOUND|USER_DISABLED/.test(reason)) {
            throw Object.assign(new Error(reason), { code: `auth/${reason.toLowerCase().replace(/[^a-z]+/g, '-')}` });
        }
        throw new Error(`Identity Toolkit HTTP ${response.status} ${reason}`.trim());
    }
    const user = body?.users?.[0];
    if (!user) throw Object.assign(new Error('USER_NOT_FOUND'), { code: 'auth/user-not-found' });
    return { email: user.email || '', email_verified: user.emailVerified === true };
}

export function realDeps(env = process.env) {
    const root = `artifacts/${env.APP_ID || 'silvia-chinellato-app'}/shared/data`;
    return {
        env,
        now: () => new Date(),
        fetch: (...args) => fetch(...args),
        verifyUser: (token) => lookupFirebaseUser(token, { apiKey: env.FIREBASE_WEB_API_KEY || FIREBASE_WEB_API_KEY, fetchImpl: (...args) => fetch(...args) }),
        async loadData() {
            const { db } = await firebaseAdmin(env);
            const [events, patients, centers, messaging, status] = await Promise.all([
                db.collection(`${root}/studio_events`).get(),
                db.collection(`${root}/patients_list`).get(),
                db.collection(`${root}/centers_list`).get(),
                db.doc(`${root}/settings/messaging`).get(),
                db.doc(`${root}/settings/daily_reminder`).get()
            ]);
            return {
                events: events.docs.map(d => d.data()),
                patients: patients.docs.map(d => ({ id: d.data().id || d.id, ...d.data() })),
                centers: centers.docs.map(d => d.data()),
                messagingSettings: messaging.exists ? messaging.data() : null,
                status: status.exists ? status.data() : null
            };
        },
        async saveStatus(patch) {
            const { db } = await firebaseAdmin(env);
            await db.doc(`${root}/settings/daily_reminder`).set({ ...patch, updatedAt: new Date().toISOString() }, { merge: true });
        }
    };
}

export default createHandler(realDeps());
