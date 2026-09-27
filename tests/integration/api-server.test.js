/**
 * Test d'integrazione HTTP reali: la funzione api/ical.js viene servita dal server di test
 * e scarica calendari da un secondo server locale (nessun mock di fetch).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import http from 'node:http';
import { createServer } from '../support/server.mjs';
import { SIMPLE_CALENDAR } from '../fixtures/ical.js';

let app, upstream, appUrl, upstreamUrl;

function listen(server) {
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

beforeAll(async () => {
    // I server di prova girano su 127.0.0.1: in produzione questi host sono bloccati (SSRF).
    process.env.ICAL_ALLOW_PRIVATE_HOSTS = '1';
    upstream = http.createServer((req, res) => {
        switch (req.url) {
            case '/calendar.ics': res.writeHead(200, { 'content-type': 'text/calendar' }).end(SIMPLE_CALENDAR); break;
            case '/redirect': res.writeHead(302, { location: '/calendar.ics' }).end(); break;
            case '/private': res.writeHead(200, { 'content-type': 'text/html' }).end('<html>Accedi</html>'); break;
            case '/empty': res.writeHead(200).end(''); break;
            case '/forbidden': res.writeHead(403).end('no'); break;
            default: res.writeHead(404).end('nope');
        }
    });
    upstreamUrl = await listen(upstream);
    app = createServer();
    appUrl = await listen(app);
});

afterAll(async () => {
    delete process.env.ICAL_ALLOW_PRIVATE_HOSTS;
    await new Promise(r => app.close(r));
    await new Promise(r => upstream.close(r));
});

const callApi = (target, init) => fetch(`${appUrl}/api/ical?url=${encodeURIComponent(target)}`, init);

describe('GET /api/ical (HTTP reale)', () => {
    it('scarica e restituisce un calendario valido con intestazioni CORS', async () => {
        const res = await callApi(`${upstreamUrl}/calendar.ics`);
        expect(res.status).toBe(200);
        expect(res.headers.get('access-control-allow-origin')).toBe('*');
        expect(res.headers.get('content-type')).toContain('application/json');
        expect((await res.json()).icsContent).toBe(SIMPLE_CALENDAR);
    });

    it('segue i redirect', async () => {
        const res = await callApi(`${upstreamUrl}/redirect`);
        expect(res.status).toBe(200);
        expect((await res.json()).icsContent).toContain('BEGIN:VCALENDAR');
    });

    it('propaga gli errori HTTP del server remoto', async () => {
        const res = await callApi(`${upstreamUrl}/forbidden`);
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'Errore HTTP 403', targetUrl: `${upstreamUrl}/forbidden` });
    });

    it('rifiuta pagine HTML (calendario non pubblico)', async () => {
        const res = await callApi(`${upstreamUrl}/private`);
        expect(res.status).toBe(500);
        expect((await res.json()).preview).toBe('<html>Accedi</html>');
    });

    it('rifiuta risposte vuote', async () => {
        const res = await callApi(`${upstreamUrl}/empty`);
        expect(res.status).toBe(500);
    });

    it('restituisce 500 se l’host non è raggiungibile', async () => {
        const closed = http.createServer();
        const closedUrl = await listen(closed);
        await new Promise(r => closed.close(r));
        const res = await callApi(`${closedUrl}/calendar.ics`);
        expect(res.status).toBe(500);
        expect((await res.json()).error).toBeTruthy();
    });

    it('senza ICAL_ALLOW_PRIVATE_HOSTS blocca gli host locali', async () => {
        delete process.env.ICAL_ALLOW_PRIVATE_HOSTS;
        try {
            const res = await callApi(`${upstreamUrl}/calendar.ics`);
            expect(res.status).toBe(400);
        } finally {
            process.env.ICAL_ALLOW_PRIVATE_HOSTS = '1';
        }
    });

    it('rifiuta le richieste POST', async () => {
        const res = await callApi(`${upstreamUrl}/calendar.ics`, { method: 'POST' });
        expect(res.status).toBe(405);
    });

    it('risponde alle richieste preflight', async () => {
        const res = await fetch(`${appUrl}/api/ical`, { method: 'OPTIONS' });
        expect(res.status).toBe(200);
        expect(res.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');
    });

    it('restituisce 400 senza parametro url', async () => {
        const res = await fetch(`${appUrl}/api/ical`);
        expect(res.status).toBe(400);
    });
});

describe('server statico di test', () => {
    it('serve index.html sulla radice e le immagini', async () => {
        const index = await fetch(`${appUrl}/`);
        expect(index.status).toBe(200);
        expect(await index.text()).toContain('<title>Silvia Chinellato');
        const logo = await fetch(`${appUrl}/Logo.jpeg`);
        expect(logo.headers.get('content-type')).toBe('image/jpeg');
    });

    it('non espone node_modules né i file di test', async () => {
        expect((await fetch(`${appUrl}/node_modules/acorn/package.json`)).status).toBe(404);
        expect((await fetch(`${appUrl}/tests/support/server.mjs`)).status).toBe(404);
    });
});
