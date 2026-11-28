import { firebaseAdmin, sharedRoot } from './_shared.js';
import { DEFAULT_STATS_HOST, countersFor, isBot, mergeObject, originHost, requestHost } from './_statistiche-core.js';

/**
 * POST /api/statistiche – segnale anonimo di visita dal sito pubblico (assets/js/statistiche.js).
 *
 * Aggiorna solo totali giornalieri in Firestore (shared/data/site_stats/{AAAA-MM-GG}), letti
 * dall'area riservata. Non salva indirizzi IP, browser o altri dati della persona.
 * Si contano solo le richieste arrivate all'indirizzo pubblico del sito (STATS_HOST), con
 * Origin dello stesso sito, e non i robot: anteprime, prove e richieste da altri siti sono ignorate.
 * Risponde sempre 204 (anche quando ignora il segnale), così non rivela nulla a chi prova a forzarlo.
 *
 * Variabili d'ambiente: FIREBASE_SERVICE_ACCOUNT; facoltative STATS_HOST e APP_ID.
 */
const MAX_BODY_CHARS = 2000;

function parseSignal(body) {
    if (body && typeof body === 'object' && !Buffer.isBuffer(body)) return body;
    const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body || '');
    if (!text || text.length > MAX_BODY_CHARS) return null;
    try { return JSON.parse(text); } catch { return null; }
}

export function createHandler(deps) {
    return async function handler(req, res) {
        res.setHeader('Cache-Control', 'no-store');
        if (req.method !== 'POST') {
            res.setHeader('Allow', 'POST');
            return res.status(405).json({ error: 'Metodo non consentito' });
        }
        const headers = req.headers || {};
        const siteHost = String(deps.env.STATS_HOST || DEFAULT_STATS_HOST).toLowerCase();
        const origin = originHost(headers);
        if (requestHost(headers) !== siteHost || (origin && origin !== siteHost) || isBot(headers['user-agent'])) {
            return res.status(204).end();
        }
        const signal = parseSignal(req.body);
        const update = signal && JSON.stringify(signal).length <= MAX_BODY_CHARS
            ? countersFor(signal, { headers, now: deps.now(), siteHost })
            : null;
        if (!update) return res.status(204).end();
        try {
            await deps.save(update.date, update.counters);
        } catch (err) {
            console.error('Statistiche non salvate:', err?.message);
            return res.status(500).json({ error: 'Statistiche non salvate' });
        }
        return res.status(204).end();
    };
}

export function realDeps(env = process.env) {
    return {
        env,
        now: () => new Date(),
        async save(date, counters) {
            const [{ db }, { FieldValue }] = await Promise.all([firebaseAdmin(env), import('firebase-admin/firestore')]);
            const data = mergeObject(date, counters, (amount) => FieldValue.increment(amount));
            data.updatedAt = FieldValue.serverTimestamp();
            await db.doc(`${sharedRoot(env)}/site_stats/${date}`).set(data, { merge: true });
        }
    };
}

export default createHandler(realDeps());
