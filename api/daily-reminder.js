import { buildDigest, romeParts, SEND_FROM_HOUR } from './_daily-reminder-core.js';
import {
    AUTHORIZED_EMAILS, FIREBASE_WEB_API_KEY, appUrl, bearerToken, firebaseAdmin, isCronRequest, lookupFirebaseUser,
    parseServiceAccount, sendCallMeBot, sharedRoot
} from './_shared.js';
import { firestoreSyncDeps, runCalendarSync } from './_calendar-sync.js';

export { AUTHORIZED_EMAILS, FIREBASE_WEB_API_KEY, firebaseAdmin, lookupFirebaseUser, parseServiceAccount, sendCallMeBot };

/**
 * Riepilogo mattutino su WhatsApp (CallMeBot) per Silvia.
 *
 * GET  – chiamata dal cron di Vercel con `Authorization: Bearer <CRON_SECRET>`.
 *        Invia al massimo una volta al giorno, dalle 7:00 (ora di Roma), solo se
 *        l'invio automatico è attivo nell'app (settings/messaging.dailyDigestEnabled).
 *        Prima di comporre il testo sincronizza i calendari, così il riepilogo è aggiornato
 *        anche se Silvia non ha aperto l'app.
 * POST – "Invia una prova ora" dall'app, con il token Firebase di un account autorizzato.
 *
 * Variabili d'ambiente: CALLMEBOT_PHONE, CALLMEBOT_APIKEY, CRON_SECRET,
 * FIREBASE_SERVICE_ACCOUNT (JSON della chiave), facoltative APP_URL, APP_ID e FIREBASE_WEB_API_KEY.
 */
export const TEST_COOLDOWN_MS = 60000;

function missingConfig(env) {
    return ['CALLMEBOT_PHONE', 'CALLMEBOT_APIKEY', 'FIREBASE_SERVICE_ACCOUNT'].filter(name => !String(env[name] || '').trim());
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
            if (!isCronRequest(req, env)) return res.status(401).json({ error: 'Non autorizzato' });
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

        const digestOptions = { appUrl: appUrl(req, env), test: isTest };
        let digest = buildDigest(data, now, digestOptions);
        if (!isTest && !force && status.lastSentDay === digest.todayKey) {
            return res.status(200).json({ status: 'skipped', reason: 'Riepilogo di oggi già inviato' });
        }

        // Calendari aggiornati prima del riepilogo: se la sincronizzazione non riesce si invia comunque.
        if (!isTest && deps.syncCalendars) {
            try {
                const result = await deps.syncCalendars(now, digestOptions.appUrl);
                if (result?.status === 'ok' && result.writes > 0) {
                    data = await deps.loadData();
                    digest = buildDigest(data, now, digestOptions);
                }
            } catch (err) {
                console.error('Riepilogo WhatsApp: sincronizzazione dei calendari non riuscita', err?.message);
            }
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

export function realDeps(env = process.env) {
    const root = sharedRoot(env);
    return {
        env,
        now: () => new Date(),
        fetch: (...args) => fetch(...args),
        verifyUser: (token) => lookupFirebaseUser(token, { apiKey: env.FIREBASE_WEB_API_KEY || FIREBASE_WEB_API_KEY, fetchImpl: (...args) => fetch(...args) }),
        syncCalendars: (now, url) => runCalendarSync(firestoreSyncDeps(env), { now, appUrl: url, waitForLock: true }),
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
