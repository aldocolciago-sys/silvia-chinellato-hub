import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import handler from '../../api/ical.js';
import { createMockReq, createMockRes } from '../support/vercel-mock.js';
import { SIMPLE_CALENDAR, HTML_LOGIN_PAGE, vcalendar, vevent } from '../fixtures/ical.js';

function textResponse(body, { status = 200, contentType = 'text/calendar' } = {}) {
    return new Response(body, { status, headers: { 'content-type': contentType } });
}

async function callHandler(query, { method = 'GET' } = {}) {
    const req = createMockReq({ method, query });
    const res = createMockRes();
    await handler(req, res);
    return res;
}

describe('api/ical – proxy serverless per calendari iCal', () => {
    let fetchMock;

    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    describe('CORS e validazione input', () => {
        it('imposta sempre le intestazioni CORS', async () => {
            const res = await callHandler({});
            expect(res.headers['access-control-allow-origin']).toBe('*');
            expect(res.headers['access-control-allow-methods']).toBe('GET, OPTIONS');
        });

        it('risponde 200 vuoto alle richieste preflight OPTIONS senza chiamare fetch', async () => {
            const res = await callHandler({ url: 'https://example.com/cal.ics' }, { method: 'OPTIONS' });
            expect(res.statusCode).toBe(200);
            expect(res.ended).toBe(true);
            expect(res.body).toBeUndefined();
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it.each([
            ['parametro assente', {}],
            ['stringa vuota', { url: '' }]
        ])('restituisce 400 se l’URL è mancante (%s)', async (_label, query) => {
            const res = await callHandler(query);
            expect(res.statusCode).toBe(400);
            expect(res.body).toEqual({ error: 'URL iCal mancante' });
            expect(fetchMock).not.toHaveBeenCalled();
        });
    });

    describe('download del calendario', () => {
        it('restituisce il contenuto ICS in JSON quando la risposta è valida', async () => {
            fetchMock.mockResolvedValue(textResponse(SIMPLE_CALENDAR));
            const res = await callHandler({ url: 'https://example.com/cal.ics' });
            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual({ icsContent: SIMPLE_CALENDAR });
        });

        it('passa redirect "follow", un AbortSignal e l’header Accept adeguato', async () => {
            fetchMock.mockResolvedValue(textResponse(SIMPLE_CALENDAR));
            await callHandler({ url: 'https://example.com/cal.ics' });
            expect(fetchMock).toHaveBeenCalledTimes(1);
            const [url, init] = fetchMock.mock.calls[0];
            expect(url).toBe('https://example.com/cal.ics');
            expect(init.redirect).toBe('follow');
            expect(init.signal).toBeInstanceOf(AbortSignal);
            expect(init.headers.Accept).toContain('text/calendar');
        });

        it('accetta anche un frammento che contiene solo BEGIN:VEVENT', async () => {
            const fragment = vevent({ uid: 'x', summary: 'Solo evento', start: '20300101T090000Z' });
            fetchMock.mockResolvedValue(textResponse(fragment));
            const res = await callHandler({ url: 'https://example.com/frag.ics' });
            expect(res.statusCode).toBe(200);
            expect(res.body.icsContent).toBe(fragment);
        });

        it.each([403, 404, 500, 503])('propaga lo stato HTTP %i del server remoto', async (status) => {
            fetchMock.mockResolvedValue(textResponse('errore', { status }));
            const res = await callHandler({ url: 'https://example.com/cal.ics' });
            expect(res.statusCode).toBe(status);
            expect(res.body).toEqual({ error: `Errore HTTP ${status}`, targetUrl: 'https://example.com/cal.ics' });
        });

        it('restituisce 500 se il server remoto risponde con corpo vuoto', async () => {
            fetchMock.mockResolvedValue(textResponse(''));
            const res = await callHandler({ url: 'https://example.com/cal.ics' });
            expect(res.statusCode).toBe(500);
            expect(res.body.error).toMatch(/risposta vuota/);
        });

        it('restituisce 500 con anteprima (max 300 caratteri) se la risposta non è un calendario', async () => {
            const longHtml = HTML_LOGIN_PAGE + 'x'.repeat(1000);
            fetchMock.mockResolvedValue(textResponse(longHtml, { contentType: 'text/html' }));
            const res = await callHandler({ url: 'https://example.com/cal.ics' });
            expect(res.statusCode).toBe(500);
            expect(res.body.error).toMatch(/non contiene un calendario iCal valido/);
            expect(res.body.preview).toHaveLength(300);
            expect(longHtml.startsWith(res.body.preview)).toBe(true);
        });

        it('restituisce 500 con il messaggio d’errore se fetch fallisce (es. DNS)', async () => {
            fetchMock.mockRejectedValue(new TypeError('fetch failed'));
            const res = await callHandler({ url: 'https://host-inesistente.invalid/cal.ics' });
            expect(res.statusCode).toBe(500);
            expect(res.body).toEqual({ error: 'fetch failed' });
        });

        it('restituisce 504 se la richiesta viene interrotta (AbortError)', async () => {
            const abortError = new Error('aborted');
            abortError.name = 'AbortError';
            fetchMock.mockRejectedValue(abortError);
            const res = await callHandler({ url: 'https://example.com/cal.ics' });
            expect(res.statusCode).toBe(504);
            expect(res.body.error).toMatch(/Timeout/);
        });

        it('interrompe il download dopo 15 secondi e risponde 504', async () => {
            vi.useFakeTimers();
            fetchMock.mockImplementation((_url, { signal }) => new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => {
                    const err = new Error('The operation was aborted');
                    err.name = 'AbortError';
                    reject(err);
                });
            }));
            const pending = callHandler({ url: 'https://lento.example.com/cal.ics' });
            await vi.advanceTimersByTimeAsync(14999);
            expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            const res = await pending;
            expect(res.statusCode).toBe(504);
        });

        it('annulla il timer di timeout quando la risposta arriva in tempo', async () => {
            vi.useFakeTimers();
            fetchMock.mockResolvedValue(textResponse(SIMPLE_CALENDAR));
            await callHandler({ url: 'https://example.com/cal.ics' });
            expect(vi.getTimerCount()).toBe(0);
            expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
        });
    });

    describe('normalizzazione degli URL Google Calendar', () => {
        async function resolvedTarget(url) {
            fetchMock.mockResolvedValue(textResponse(SIMPLE_CALENDAR));
            await callHandler({ url });
            return fetchMock.mock.calls.at(-1)[0];
        }

        it('lascia invariati gli URL non Google', async () => {
            expect(await resolvedTarget('https://outlook.office365.com/owa/calendar/x/calendar.ics'))
                .toBe('https://outlook.office365.com/owa/calendar/x/calendar.ics');
        });

        it('lascia invariati gli URL Google senza parametro cid', async () => {
            const url = 'https://calendar.google.com/calendar/ical/silviachine%40gmail.com/public/basic.ics';
            expect(await resolvedTarget(url)).toBe(url);
        });

        it('decodifica un cid base64 nell’URL ICS pubblico', async () => {
            expect(await resolvedTarget('https://calendar.google.com/calendar/u/0?cid=c2lsdmlhY2hpbmVAZ21haWwuY29t'))
                .toBe('https://calendar.google.com/calendar/ical/silviachine@gmail.com/public/basic.ics');
        });

        it('decodifica un cid base64 con padding di un calendario di gruppo', async () => {
            expect(await resolvedTarget('https://calendar.google.com/calendar/r?cid=YWJjMTIzQGdyb3VwLmNhbGVuZGFyLmdvb2dsZS5jb20='))
                .toBe('https://calendar.google.com/calendar/ical/abc123@group.calendar.google.com/public/basic.ics');
        });

        it('usa il cid in chiaro (URL-encoded) quando non è base64', async () => {
            expect(await resolvedTarget('https://calendar.google.com/calendar/r?cid=abc123%40group.calendar.google.com'))
                .toBe('https://calendar.google.com/calendar/ical/abc123@group.calendar.google.com/public/basic.ics');
        });

        it('lascia invariata una stringa che non è un URL valido', async () => {
            expect(await resolvedTarget('non-un-url calendar.google.com')).toBe('non-un-url calendar.google.com');
        });

        it('include l’URL normalizzato nella risposta di errore HTTP', async () => {
            fetchMock.mockResolvedValue(textResponse('', { status: 404 }));
            const res = await callHandler({ url: 'https://calendar.google.com/calendar/u/0?cid=c2lsdmlhY2hpbmVAZ21haWwuY29t' });
            expect(res.body.targetUrl).toBe('https://calendar.google.com/calendar/ical/silviachine@gmail.com/public/basic.ics');
        });
    });

    describe('sicurezza (problemi noti)', () => {
        // KNOWN ISSUE: il proxy scarica qualunque URL, inclusi host interni/metadata cloud (SSRF).
        // Quando verrà introdotta una allow-list, rimuovere `.fails`.
        it.fails('rifiuta URL verso indirizzi interni o link-local (SSRF)', async () => {
            fetchMock.mockResolvedValue(textResponse(SIMPLE_CALENDAR));
            const res = await callHandler({ url: 'http://169.254.169.254/latest/meta-data/' });
            expect(res.statusCode).toBe(400);
            expect(fetchMock).not.toHaveBeenCalled();
        });

        // KNOWN ISSUE: sono accettati anche metodi diversi da GET/OPTIONS.
        it.fails('rifiuta metodi HTTP diversi da GET e OPTIONS con 405', async () => {
            fetchMock.mockResolvedValue(textResponse(SIMPLE_CALENDAR));
            const res = await callHandler({ url: 'https://example.com/cal.ics' }, { method: 'POST' });
            expect(res.statusCode).toBe(405);
        });
    });
});
