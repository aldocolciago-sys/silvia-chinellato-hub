import { appUrl, isCronRequest } from './_shared.js';
import { firestoreSyncDeps, runCalendarSync } from './_calendar-sync.js';

/**
 * Sincronizzazione automatica dei calendari, chiamata ogni ora da GitHub Actions
 * (.github/workflows/calendar-sync.yml) con `Authorization: Bearer <CRON_SECRET>`.
 *
 * Aggiorna l'agenda in Firestore e, se cambia qualcosa nei poliambulatori o nei turni,
 * avvisa Silvia su WhatsApp. La risposta contiene solo dei conteggi: i log di GitHub
 * Actions di un repository pubblico sono visibili a tutti.
 */
export function createHandler(deps) {
    return async function handler(req, res) {
        res.setHeader('Cache-Control', 'no-store');
        if (req.method !== 'GET') {
            res.setHeader('Allow', 'GET');
            return res.status(405).json({ error: 'Metodo non consentito' });
        }
        const env = deps.env;
        if (!isCronRequest(req, env)) return res.status(401).json({ error: 'Non autorizzato' });
        if (!String(env.FIREBASE_SERVICE_ACCOUNT || '').trim()) return res.status(500).json({ error: 'Configurazione mancante su Vercel: FIREBASE_SERVICE_ACCOUNT' });
        try {
            const result = await deps.run({ now: deps.now(), appUrl: appUrl(req, env) });
            if (result.status === 'busy') return res.status(200).json({ status: 'busy', reason: 'Sincronizzazione già in corso' });
            return res.status(200).json({ status: 'ok', counts: result.counts, notified: result.notified });
        } catch (err) {
            console.error('Sincronizzazione calendari non riuscita:', err?.message);
            return res.status(500).json({ error: err?.code === 'config/service-account' ? err.message : 'Sincronizzazione non riuscita' });
        }
    };
}

export function realDeps(env = process.env) {
    return {
        env,
        now: () => new Date(),
        run: (options) => runCalendarSync(firestoreSyncDeps(env), options)
    };
}

export default createHandler(realDeps());
