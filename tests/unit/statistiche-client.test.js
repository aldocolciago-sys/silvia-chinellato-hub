import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { ROOT } from '../support/app-source.js';

/** Script delle statistiche di visita della pagina pubblica (assets/js/statistiche.js). */
const SCRIPT = readFileSync(path.join(ROOT, 'assets', 'js', 'statistiche.js'), 'utf8');
const SITE = 'https://silvia-chinellato-hub.vercel.app';

function load({ url = `${SITE}/`, referrer = '', html = '', storage, beacon = true } = {}) {
    const dom = new JSDOM(`<!DOCTYPE html><body>${html}</body>`, { url, ...(referrer ? { referrer } : {}), runScripts: 'outside-only' });
    const { window } = dom;
    const sent = [];
    window.Blob = function (parts, options) { this.parts = parts; this.type = options?.type; };
    window.navigator.sendBeacon = beacon ? (endpoint, blob) => { sent.push({ endpoint, type: blob.type, body: JSON.parse(blob.parts[0]) }); return true; } : undefined;
    window.fetch = (endpoint, options) => { sent.push({ endpoint, type: options.headers['Content-Type'], body: JSON.parse(options.body), fetch: true }); return Promise.resolve(); };
    if (storage) storage(window);
    window.eval(SCRIPT);
    return { window, document: window.document, sent };
}

describe('statistiche di visita: pagina pubblica', () => {
    it('all\'apertura invia la pagina, il dominio di provenienza e la nuova visita (nessun cookie)', () => {
        const { sent, document } = load({ referrer: 'https://www.google.it/search?q=osteopata+carate' });
        expect(sent).toEqual([{ endpoint: '/api/statistiche', type: 'application/json', body: { tipo: 'pagina', percorso: '/', provenienza: 'www.google.it', utm: '', nuovaVisita: true } }]);
        expect(document.cookie).toBe('');
    });

    it('invia solo il dominio di provenienza, mai l\'indirizzo completo con la ricerca', () => {
        const { sent } = load({ referrer: 'https://www.google.it/search?q=dati+personali' });
        expect(JSON.stringify(sent)).not.toContain('dati');
    });

    it('le pagine successive della stessa visita non contano come nuova visita', () => {
        const { sent } = load({ url: `${SITE}/privacy.html`, storage: (w) => w.sessionStorage.setItem('statisticheVisitaInCorso', '1') });
        expect(sent[0].body).toMatchObject({ percorso: '/privacy.html', nuovaVisita: false });
    });

    it('legge utm_source (es. futuri QR del volantino)', () => {
        const { sent } = load({ url: `${SITE}/?utm_source=volantino` });
        expect(sent[0].body.utm).toBe('volantino');
    });

    it('i dispositivi di Silvia e Aldo non inviano nulla', () => {
        const { sent, document, window } = load({ html: '<a data-stat="instagram" href="#">IG</a>', storage: (w) => w.localStorage.setItem('statisticheIgnoraDispositivo', '1') });
        document.querySelector('a').click();
        document.dispatchEvent(new window.CustomEvent('statistiche:evento', { detail: 'richiesta_appuntamento' }));
        expect(sent).toEqual([]);
    });

    it('conta i clic sugli elementi con data-stat, con il dettaglio se presente', () => {
        const { sent, document } = load({ html: '<a data-stat="instagram" href="#"><span>IG</span></a><a data-stat="centro_prenota" data-stat-dettaglio="Centro Polisalute" href="#">Prenota</a>' });
        document.querySelector('span').click();
        document.querySelectorAll('a')[1].click();
        expect(sent.slice(1).map(s => s.body)).toEqual([
            { tipo: 'evento', nome: 'instagram' },
            { tipo: 'evento', nome: 'centro_prenota', dettaglio: 'Centro Polisalute' }
        ]);
    });

    it('conta le domande frequenti aperte (non quelle chiuse) con il testo della domanda', () => {
        const { sent, document, window } = load({ html: '<details class="faq-item"><summary>Quando non si esegue?<i></i></summary><div>…</div></details>' });
        const item = document.querySelector('details');
        item.open = true;
        item.dispatchEvent(new window.Event('toggle'));
        item.open = false;
        item.dispatchEvent(new window.Event('toggle'));
        expect(sent.slice(1).map(s => s.body)).toEqual([{ tipo: 'evento', nome: 'faq', dettaglio: 'Quando non si esegue?' }]);
    });

    it('riceve gli eventi della pagina, es. richiesta di appuntamento inviata', () => {
        const { sent, document, window } = load();
        document.dispatchEvent(new window.CustomEvent('statistiche:evento', { detail: 'richiesta_appuntamento' }));
        expect(sent.at(-1).body).toEqual({ tipo: 'evento', nome: 'richiesta_appuntamento' });
    });

    it('senza sendBeacon usa fetch, senza credenziali', () => {
        const { sent } = load({ beacon: false });
        expect(sent[0]).toMatchObject({ fetch: true, endpoint: '/api/statistiche' });
    });

    it('statisticheIgnoraDispositivo(true/false) attiva e disattiva l\'esclusione', () => {
        const { window } = load();
        window.statisticheIgnoraDispositivo(true);
        expect(window.localStorage.getItem('statisticheIgnoraDispositivo')).toBe('1');
        window.statisticheIgnoraDispositivo(false);
        expect(window.localStorage.getItem('statisticheIgnoraDispositivo')).toBeNull();
    });
});
