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
 * FIREBASE_SERVICE_ACCOUNT (JSON della chiave), facoltative APP_URL e APP_ID.
 */
export const AUTHORIZED_EMAILS = ['silviachine@gmail.com', 'aldo.colciago@gmail.com'];
export const TEST_COOLDOWN_MS = 60000;
const CALLMEBOT_URL = 'https://api.callmebot.com/whatsapp.php';
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
            let user;
            try {
                user = await deps.verifyUser(token);
            } catch {
                return res.status(401).json({ error: 'Sessione non valida: esci e rientra nell\'area riservata.' });
            }
            const email = String(user?.email || '').toLowerCase();
            if (!user?.email_verified || !AUTHORIZED_EMAILS.includes(email)) return res.status(403).json({ error: 'Account non autorizzato' });
        }

        const missing = ['CALLMEBOT_PHONE', 'CALLMEBOT_APIKEY', 'FIREBASE_SERVICE_ACCOUNT'].filter(name => !env[name]);
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
            console.error('Riepilogo WhatsApp: lettura dati non riuscita', err);
            return res.status(500).json({ error: 'Lettura dei dati non riuscita' });
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

let adminPromise = null;
/** Firebase Admin, inizializzato una sola volta per istanza. */
export function firebaseAdmin(env = process.env) {
    adminPromise ??= (async () => {
        const [{ initializeApp, getApps, cert }, { getFirestore }, { getAuth }] = await Promise.all([
            import('firebase-admin/app'), import('firebase-admin/firestore'), import('firebase-admin/auth')
        ]);
        const app = getApps()[0] || initializeApp({ credential: cert(JSON.parse(env.FIREBASE_SERVICE_ACCOUNT)) });
        return { db: getFirestore(app), auth: getAuth(app) };
    })();
    adminPromise.catch(() => { adminPromise = null; });
    return adminPromise;
}

export function realDeps(env = process.env) {
    const root = `artifacts/${env.APP_ID || 'silvia-chinellato-app'}/shared/data`;
    return {
        env,
        now: () => new Date(),
        fetch: (...args) => fetch(...args),
        async verifyUser(token) {
            const { auth } = await firebaseAdmin(env);
            return auth.verifyIdToken(token);
        },
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
