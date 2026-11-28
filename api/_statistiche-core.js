import { romeParts } from './_daily-reminder-core.js';

/**
 * Statistiche di visita anonime del sito pubblico (senza cookie, senza indirizzi IP salvati).
 *
 * Ogni segnale inviato dalla pagina aggiorna solo dei TOTALI giornalieri, in un documento per
 * giorno: artifacts/{appId}/shared/data/site_stats/{AAAA-MM-GG}. Nessun dato riconduce a una
 * persona: la zona (comune) arriva già calcolata da Vercel e viene solo contata.
 */

/** Indirizzo del sito pubblico: si contano solo le visite qui (non anteprime né prove in locale). */
export const DEFAULT_STATS_HOST = 'silvia-chinellato-hub.vercel.app';

/** Pagine contate: percorso → chiave del contatore (/index.html vale come la home). */
export const PAGES = { '/': 'home', '/index.html': 'home', '/privacy.html': 'privacy' };

/** Azioni sul sito che si possono contare, con l'etichetta mostrata nell'area riservata. */
export const EVENT_LABELS = {
    instagram: 'Clic su Instagram',
    email: "Clic sull'email",
    telefono: 'Tocchi per vedere il telefono',
    maps: 'Apertura di Google Maps',
    centro_sito: 'Clic su "Sito web" di un centro',
    centro_prenota: 'Clic su "Prenota" di un centro',
    faq: 'Domande frequenti aperte',
    richiesta_appuntamento: 'Richieste di appuntamento inviate'
};

/** Provenienze, con l'etichetta mostrata nell'area riservata. */
export const SOURCE_LABELS = {
    google: 'Google',
    bing: 'Bing',
    assistenti_ai: 'Assistenti AI (ChatGPT e simili)',
    instagram: 'Instagram',
    facebook: 'Facebook',
    whatsapp: 'WhatsApp',
    miodottore: 'MioDottore',
    cms: 'Sito del CMS',
    altri_siti: 'Altri siti',
    diretto: 'Diretto (QR, link salvati, app)'
};

const BOT_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|headless|lighthouse|pagespeed|curl|wget|python|axios|node-fetch|go-http|java\/|monitor|uptime/i;

export function isBot(userAgent) {
    const ua = String(userAgent || '');
    return !ua.trim() || BOT_UA.test(ua);
}

/** Telefono, tablet o computer, dal browser che invia il segnale. */
export function deviceFromUserAgent(userAgent) {
    const ua = String(userAgent || '');
    if (/iPad|Tablet|PlayBook|Silk|Kindle/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return 'tablet';
    if (/Mobi|iPhone|iPod|Android|Windows Phone/i.test(ua)) return 'telefono';
    return 'computer';
}

const SOURCE_RULES = [
    [/(^|\.)google\./, 'google'],
    [/(^|\.)bing\.com$|(^|\.)duckduckgo\.com$|(^|\.)ecosia\.org$|(^|\.)yahoo\./, 'bing'],
    [/(^|\.)chatgpt\.com$|(^|\.)openai\.com$|(^|\.)perplexity\.ai$|(^|\.)claude\.ai$|(^|\.)copilot\.microsoft\.com$|(^|\.)gemini\.google\.com$/, 'assistenti_ai'],
    [/(^|\.)instagram\.com$/, 'instagram'],
    [/(^|\.)facebook\.com$|(^|\.)fb\.com$|(^|\.)fb\.me$/, 'facebook'],
    [/(^|\.)whatsapp\.(com|net)$|^wa\.me$/, 'whatsapp'],
    [/(^|\.)miodottore\.it$/, 'miodottore'],
    [/(^|\.)cmscarate\.com$/, 'cms']
];

/**
 * Provenienza di una nuova visita: dal parametro utm_source (es. QR futuri ?utm_source=volantino)
 * o dal dominio della pagina di provenienza. Restituisce null per la navigazione interna al sito.
 */
export function sourceFrom({ referrerHost = '', utmSource = '', siteHost = DEFAULT_STATS_HOST } = {}) {
    const utm = String(utmSource || '').toLowerCase().trim();
    if (utm) {
        if (/^(qr|volantin)/.test(utm)) return 'diretto';
        for (const key of Object.keys(SOURCE_LABELS)) if (utm.startsWith(key)) return key;
    }
    const host = String(referrerHost || '').toLowerCase().trim().replace(/^www\./, '');
    if (!host) return 'diretto';
    if (host === siteHost.replace(/^www\./, '')) return null;
    // gemini.google.com è un assistente, non la ricerca: si controlla prima di google.*
    if (/(^|\.)gemini\.google\.com$/.test(host)) return 'assistenti_ai';
    for (const [rule, source] of SOURCE_RULES) if (rule.test(host)) return source;
    return 'altri_siti';
}

/** Vercel dà i nomi delle città in inglese: si usano quelli italiani. */
export const ITALIAN_CITY_NAMES = {
    Milan: 'Milano', Rome: 'Roma', Turin: 'Torino', Naples: 'Napoli', Florence: 'Firenze', Venice: 'Venezia',
    Genoa: 'Genova', Padua: 'Padova', Mantua: 'Mantova', Syracuse: 'Siracusa', Leghorn: 'Livorno'
};

/** Comune da cui ci si collega, già calcolato da Vercel dall'indirizzo IP (che non viene salvato). */
export function placeFromHeaders(headers = {}) {
    const country = String(headers['x-vercel-ip-country'] || '').toUpperCase();
    if (country && country !== 'IT') return 'Estero';
    let city = String(headers['x-vercel-ip-city'] || '');
    try { city = decodeURIComponent(city); } catch { /* nome non codificato */ }
    city = city.replace(/[^\p{L}\p{M}' -]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 50);
    return ITALIAN_CITY_NAMES[city] || city || 'Non disponibile';
}

/** Testo libero breve (domanda frequente, nome del centro) ridotto a caratteri sicuri. */
export function cleanDetail(value) {
    return String(value || '').normalize('NFC').replace(/[^\p{L}\p{M}\p{N}' -]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

/** Host della richiesta (dietro il proxy di Vercel). */
export function requestHost(headers = {}) {
    return String(headers['x-forwarded-host'] || headers.host || '').split(',')[0].trim().toLowerCase();
}

/** Host dell'intestazione Origin, se presente. */
export function originHost(headers = {}) {
    try { return headers.origin ? new URL(headers.origin).hostname.toLowerCase() : ''; } catch { return ''; }
}

/**
 * Trasforma un segnale della pagina nei contatori da incrementare.
 * Restituisce null se il segnale non va contato.
 */
export function countersFor(signal, { headers = {}, now = new Date(), siteHost = DEFAULT_STATS_HOST } = {}) {
    if (!signal || typeof signal !== 'object') return null;
    const p = romeParts(now);
    const date = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
    const counters = {};
    const add = (path, amount = 1) => { counters[path] = (counters[path] || 0) + amount; };

    if (signal.tipo === 'pagina') {
        const page = PAGES[String(signal.percorso || '')];
        if (!page) return null;
        add('views');
        add(`pages.${page}`);
        if (signal.nuovaVisita === true) {
            const source = sourceFrom({ referrerHost: signal.provenienza, utmSource: signal.utm, siteHost });
            if (source) {
                add('visits');
                add(`sources.${source}`);
                add(`devices.${deviceFromUserAgent(headers['user-agent'])}`);
                add(`places.${placeFromHeaders(headers)}`);
                add(`hours.${String(p.hour).padStart(2, '0')}`);
            }
        }
    } else if (signal.tipo === 'evento') {
        const name = String(signal.nome || '');
        if (!Object.hasOwn(EVENT_LABELS, name)) return null;
        add(`events.${name}`);
        const detail = cleanDetail(signal.dettaglio);
        if (detail && name === 'faq') add(`faq.${detail}`);
        if (detail && (name === 'centro_sito' || name === 'centro_prenota')) add(`centers.${detail}`);
    } else {
        return null;
    }
    return { date, counters };
}

/**
 * Oggetto per set(..., { merge: true }) con incrementi annidati: le chiavi dei comuni e delle
 * domande possono contenere spazi e apostrofi, quindi non si usano percorsi con il punto.
 */
export function mergeObject(date, counters, increment) {
    const data = { date };
    for (const [path, amount] of Object.entries(counters)) {
        const dot = path.indexOf('.');
        if (dot === -1) { data[path] = increment(amount); continue; }
        const group = path.slice(0, dot);
        const key = path.slice(dot + 1);
        data[group] ??= {};
        data[group][key] = increment(amount);
    }
    return data;
}
