import { timingSafeEqual } from 'node:crypto';

/**
 * Funzioni comuni alle funzioni serverless (riepilogo delle 7 e sincronizzazione oraria):
 * accesso, Firebase Admin e invio WhatsApp con CallMeBot.
 */
export const AUTHORIZED_EMAILS = ['silviachine@gmail.com', 'aldo.colciago@gmail.com'];
const CALLMEBOT_URL = 'https://api.callmebot.com/whatsapp.php';
const IDENTITY_TOOLKIT_URL = 'https://identitytoolkit.googleapis.com/v1/accounts:lookup';
/** Chiave web pubblica del progetto Firebase (la stessa di index.html, non è un segreto). */
export const FIREBASE_WEB_API_KEY = 'AIzaSyBzrgpVFTVcdhGKawwjFPvxlkTs2iD6Xe8';
const TIMEOUT_MS = 20000;

export function bearerToken(req) {
    const header = String(req.headers?.authorization || '');
    return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

export function safeEqual(a, b) {
    const left = Buffer.from(String(a));
    const right = Buffer.from(String(b));
    return left.length === right.length && timingSafeEqual(left, right);
}

/** true se la richiesta porta il segreto dei cron (Vercel o GitHub Actions). */
export function isCronRequest(req, env) {
    const token = bearerToken(req);
    return Boolean(env.CRON_SECRET && token && safeEqual(token, env.CRON_SECRET));
}

export function appUrl(req, env) {
    if (env.APP_URL) return env.APP_URL;
    const host = req.headers?.['x-forwarded-host'] || req.headers?.host;
    return host ? `https://${host}` : '';
}

/** Percorso dei dati condivisi di Aldo e Silvia in Firestore. */
export function sharedRoot(env) {
    return `artifacts/${env.APP_ID || 'silvia-chinellato-app'}/shared/data`;
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
