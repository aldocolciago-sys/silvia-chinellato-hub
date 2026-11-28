import { describe, it, expect, vi } from 'vitest';
import {
    countersFor, deviceFromUserAgent, isBot, mergeObject, placeFromHeaders, sourceFrom, cleanDetail, EVENT_LABELS
} from '../../api/_statistiche-core.js';
import { createHandler } from '../../api/statistiche.js';

const HOST = 'silvia-chinellato-hub.vercel.app';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID_PHONE = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36';
const ANDROID_TABLET = 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
// 28/11/2026 alle 9:15 ora di Roma (UTC+1)
const NOW = new Date('2026-11-28T08:15:00Z');
const headers = (extra = {}) => ({ host: HOST, origin: `https://${HOST}`, 'user-agent': IPHONE, 'x-vercel-ip-country': 'IT', 'x-vercel-ip-city': 'Carate%20Brianza', ...extra });

describe('classificazione dei segnali', () => {
    it('riconosce telefono, tablet e computer', () => {
        expect(deviceFromUserAgent(IPHONE)).toBe('telefono');
        expect(deviceFromUserAgent(ANDROID_PHONE)).toBe('telefono');
        expect(deviceFromUserAgent(ANDROID_TABLET)).toBe('tablet');
        expect(deviceFromUserAgent('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)')).toBe('tablet');
        expect(deviceFromUserAgent(DESKTOP)).toBe('computer');
    });

    it('scarta robot e programmi automatici', () => {
        for (const ua of ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'facebookexternalhit/1.1', 'WhatsApp/2.23', 'curl/8.0', 'Mozilla/5.0 HeadlessChrome/140', '']) {
            expect(isBot(ua), ua).toBe(true);
        }
        expect(isBot(IPHONE)).toBe(false);
        expect(isBot(DESKTOP)).toBe(false);
    });

    it('capisce da dove arriva la visita', () => {
        expect(sourceFrom({ referrerHost: 'www.google.it' })).toBe('google');
        expect(sourceFrom({ referrerHost: 'www.google.com' })).toBe('google');
        expect(sourceFrom({ referrerHost: 'gemini.google.com' })).toBe('assistenti_ai');
        expect(sourceFrom({ referrerHost: 'chatgpt.com' })).toBe('assistenti_ai');
        expect(sourceFrom({ referrerHost: 'www.bing.com' })).toBe('bing');
        expect(sourceFrom({ referrerHost: 'l.instagram.com' })).toBe('instagram');
        expect(sourceFrom({ referrerHost: 'm.facebook.com' })).toBe('facebook');
        expect(sourceFrom({ referrerHost: 'www.miodottore.it' })).toBe('miodottore');
        expect(sourceFrom({ referrerHost: 'cmscarate.com' })).toBe('cms');
        expect(sourceFrom({ referrerHost: 'example.org' })).toBe('altri_siti');
        expect(sourceFrom({ referrerHost: '' })).toBe('diretto');
        expect(sourceFrom({ referrerHost: HOST }), 'navigazione interna').toBeNull();
        expect(sourceFrom({ referrerHost: '', utmSource: 'volantino-cms' })).toBe('diretto');
        expect(sourceFrom({ referrerHost: '', utmSource: 'instagram_bio' })).toBe('instagram');
    });

    it('conta il comune senza salvare l\'indirizzo IP; l\'estero è un unico gruppo', () => {
        expect(placeFromHeaders({ 'x-vercel-ip-country': 'IT', 'x-vercel-ip-city': 'Carate%20Brianza' })).toBe('Carate Brianza');
        expect(placeFromHeaders({ 'x-vercel-ip-country': 'IT', 'x-vercel-ip-city': 'Sant%27Angelo%20Lodigiano' })).toBe("Sant'Angelo Lodigiano");
        expect(placeFromHeaders({ 'x-vercel-ip-country': 'DE', 'x-vercel-ip-city': 'Berlin' })).toBe('Estero');
        expect(placeFromHeaders({ 'x-vercel-ip-country': 'IT', 'x-vercel-ip-city': 'Milan' }), 'nomi italiani').toBe('Milano');
        expect(placeFromHeaders({})).toBe('Non disponibile');
        expect(placeFromHeaders({ 'x-vercel-ip-country': 'IT', 'x-vercel-ip-city': '%3Cscript%3E.x' })).toBe('scriptx');
    });

    it('i testi liberi vengono ridotti a caratteri sicuri e brevi', () => {
        expect(cleanDetail("Dove si fa l'osteopatia?")).toBe("Dove si fa l'osteopatia");
        expect(cleanDetail('a.b/c$d<e>')).toBe('a b c d e');
        expect(cleanDetail('x'.repeat(100))).toHaveLength(60);
    });
});

describe('contatori', () => {
    it('una nuova visita aggiorna pagine, visite, provenienza, dispositivo, comune e ora (di Roma)', () => {
        const update = countersFor({ tipo: 'pagina', percorso: '/', provenienza: 'www.google.it', nuovaVisita: true }, { headers: headers(), now: NOW });
        expect(update).toEqual({
            date: '2026-11-28',
            counters: { views: 1, 'pages.home': 1, visits: 1, 'sources.google': 1, 'devices.telefono': 1, 'places.Carate Brianza': 1, 'hours.09': 1 }
        });
    });

    it('le pagine successive della stessa visita contano solo come pagine viste', () => {
        const update = countersFor({ tipo: 'pagina', percorso: '/privacy.html', provenienza: HOST, nuovaVisita: false }, { headers: headers(), now: NOW });
        expect(update.counters).toEqual({ views: 1, 'pages.privacy': 1 });
    });

    it('/index.html vale come la home; pagine sconosciute e tipi sconosciuti non si contano', () => {
        expect(countersFor({ tipo: 'pagina', percorso: '/index.html', nuovaVisita: false }, { headers: headers(), now: NOW }).counters).toEqual({ views: 1, 'pages.home': 1 });
        expect(countersFor({ tipo: 'pagina', percorso: '/wp-admin', nuovaVisita: true }, { headers: headers(), now: NOW })).toBeNull();
        expect(countersFor({ tipo: 'altro' }, { headers: headers(), now: NOW })).toBeNull();
        expect(countersFor(null, { headers: headers(), now: NOW })).toBeNull();
    });

    it('conta solo le azioni previste, con il dettaglio di domande e centri', () => {
        expect(countersFor({ tipo: 'evento', nome: 'instagram' }, { now: NOW }).counters).toEqual({ 'events.instagram': 1 });
        expect(countersFor({ tipo: 'evento', nome: 'faq', dettaglio: 'Quando non si esegue?' }, { now: NOW }).counters)
            .toEqual({ 'events.faq': 1, 'faq.Quando non si esegue': 1 });
        expect(countersFor({ tipo: 'evento', nome: 'centro_prenota', dettaglio: 'Centro Polisalute' }, { now: NOW }).counters)
            .toEqual({ 'events.centro_prenota': 1, 'centers.Centro Polisalute': 1 });
        expect(countersFor({ tipo: 'evento', nome: 'hack', dettaglio: 'x' }, { now: NOW })).toBeNull();
        expect(Object.keys(EVENT_LABELS)).toContain('richiesta_appuntamento');
    });

    it('prepara incrementi annidati (le chiavi possono contenere spazi e apostrofi)', () => {
        const inc = (n) => ({ inc: n });
        expect(mergeObject('2026-11-28', { views: 1, "places.Sant'Angelo Lodigiano": 1, 'events.faq': 2 }, inc)).toEqual({
            date: '2026-11-28', views: { inc: 1 }, places: { "Sant'Angelo Lodigiano": { inc: 1 } }, events: { faq: { inc: 2 } }
        });
    });
});

describe('POST /api/statistiche', () => {
    function call(handler, { method = 'POST', headers: h = headers(), body } = {}) {
        const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.statusCode = code; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
        return handler({ method, headers: h, body }, res).then(() => res);
    }
    const make = () => {
        const save = vi.fn(async () => {});
        return { save, handler: createHandler({ env: {}, now: () => NOW, save }) };
    };
    const visit = { tipo: 'pagina', percorso: '/', provenienza: '', nuovaVisita: true };

    it('salva i contatori di una visita valida e risponde 204', async () => {
        const { save, handler } = make();
        const res = await call(handler, { body: visit });
        expect(res.statusCode).toBe(204);
        expect(save).toHaveBeenCalledWith('2026-11-28', expect.objectContaining({ visits: 1, 'sources.diretto': 1 }));
    });

    it('accetta anche il corpo come testo JSON (invio con sendBeacon)', async () => {
        const { save, handler } = make();
        await call(handler, { body: JSON.stringify(visit) });
        expect(save).toHaveBeenCalledTimes(1);
    });

    it('ignora (204, senza salvare) anteprime, altri siti, robot, corpi troppo grandi o non validi', async () => {
        const { save, handler } = make();
        const cases = [
            { headers: headers({ host: 'silvia-chinellato-abc123-aldo-colciago.vercel.app', origin: 'https://silvia-chinellato-abc123-aldo-colciago.vercel.app' }), body: visit },
            { headers: headers({ origin: 'https://example.org' }), body: visit },
            { headers: headers({ 'user-agent': 'Googlebot/2.1' }), body: visit },
            { body: JSON.stringify({ ...visit, extra: 'x'.repeat(5000) }) },
            { body: 'non è json' },
            { body: { tipo: 'evento', nome: 'sconosciuto' } }
        ];
        for (const c of cases) expect((await call(handler, c)).statusCode).toBe(204);
        expect(save).not.toHaveBeenCalled();
    });

    it('rifiuta i metodi diversi da POST', async () => {
        const { handler } = make();
        const res = await call(handler, { method: 'GET', body: visit });
        expect(res.statusCode).toBe(405);
        expect(res.headers.Allow).toBe('POST');
    });

    it('se il database non risponde restituisce 500 senza dettagli', async () => {
        const handler = createHandler({ env: {}, now: () => NOW, save: async () => { throw new Error('credenziali segrete xyz'); } });
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const res = await call(handler, { body: visit });
        errorSpy.mockRestore();
        expect(res.statusCode).toBe(500);
        expect(JSON.stringify(res.body)).not.toContain('xyz');
    });

    it('STATS_HOST permette di cambiare l\'indirizzo contato (es. dominio futuro)', async () => {
        const save = vi.fn(async () => {});
        const handler = createHandler({ env: { STATS_HOST: 'www.silviachinellato.it' }, now: () => NOW, save });
        await call(handler, { headers: headers({ host: 'www.silviachinellato.it', origin: 'https://www.silviachinellato.it' }), body: visit });
        expect(save).toHaveBeenCalledTimes(1);
    });
});
