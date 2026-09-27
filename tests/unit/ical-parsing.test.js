import { describe, it, expect, vi, afterEach } from 'vitest';
import { loadFunctions } from '../support/app-source.js';
import handler from '../../api/ical.js';
import { createMockReq, createMockRes } from '../support/vercel-mock.js';

const { parseIcalDateTime, normalizeGoogleCalendarUrl, unfoldIcalLines, parseIcalProperty, unescapeIcalText, zonedTimeToUtc } = loadFunctions(
    ['parseIcalDateTime', 'normalizeGoogleCalendarUrl', 'unfoldIcalLines', 'parseIcalProperty', 'unescapeIcalText', 'zonedTimeToUtc'],
    { atob: globalThis.atob, URL: globalThis.URL }
);

describe('parseIcalDateTime (client)', () => {
    afterEach(() => vi.useRealTimers());

    it('esegue il test nel fuso Europe/Rome', () => {
        expect(new Date('2030-01-15T12:00:00Z').getTimezoneOffset()).toBe(-60);
        expect(new Date('2030-07-15T12:00:00Z').getTimezoneOffset()).toBe(-120);
    });

    it.each([
        ['20300115T090000Z', '2030-01-15T09:00:00.000Z'],
        ['20301231T235900Z', '2030-12-31T23:59:00.000Z'],
        ['20300229T100000Z', '2030-03-01T10:00:00.000Z'], // 2030 non è bisestile: Date.UTC normalizza
        ['20280229T100000Z', '2028-02-29T10:00:00.000Z'],
        ['20300115T093045Z', '2030-01-15T09:30:00.000Z'] // i secondi vengono ignorati
    ])('converte %s in %s', (input, expected) => {
        expect(parseIcalDateTime(input)).toBe(expected);
    });

    it('interpreta le date senza orario (VALUE=DATE) alle 09:00 UTC', () => {
        expect(parseIcalDateTime('20300115')).toBe('2030-01-15T09:00:00.000Z');
    });

    it('ignora separatori e caratteri non numerici', () => {
        expect(parseIcalDateTime('2030-01-15T09:00:00Z')).toBe('2030-01-15T09:00:00.000Z');
    });

    it.each([undefined, null, ''])('restituisce "adesso" per un valore vuoto (%s)', (value) => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2031-05-05T05:05:05.000Z'));
        expect(parseIcalDateTime(value)).toBe('2031-05-05T05:05:05.000Z');
    });

    it('restituisce "adesso" per un valore non interpretabile invece di lanciare eccezioni', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2031-05-05T05:05:05.000Z'));
        expect(parseIcalDateTime('abc')).toBe('2031-05-05T05:05:05.000Z');
    });

    // Regressione (difetto corretto): un orario locale "floating" (senza Z, tipico di DTSTART;TZID=Europe/Rome:...)
    // viene trattato come UTC, spostando l'appuntamento di 1-2 ore.
    it('interpreta gli orari senza "Z" come ora locale e non come UTC', () => {
        const iso = parseIcalDateTime('20300115T090000');
        expect(new Date(iso).getHours()).toBe(9);
    });
});

describe('parseIcalDateTime con fuso orario (TZID)', () => {
    it.each([
        ['20300115T090000', 'Europe/Rome', '2030-01-15T08:00:00.000Z'], // ora solare (UTC+1)
        ['20300715T090000', 'Europe/Rome', '2030-07-15T07:00:00.000Z'], // ora legale (UTC+2)
        ['20300715T090000', 'America/New_York', '2030-07-15T13:00:00.000Z'],
        ['20300715T090000', 'UTC', '2030-07-15T09:00:00.000Z']
    ])('%s con TZID=%s → %s', (value, tzid, expected) => {
        expect(parseIcalDateTime(value, tzid)).toBe(expected);
    });

    it('gestisce gli orari a cavallo del cambio dell’ora (ultima domenica di marzo)', () => {
        expect(parseIcalDateTime('20300331T010000', 'Europe/Rome')).toBe('2030-03-31T00:00:00.000Z');
        expect(parseIcalDateTime('20300331T040000', 'Europe/Rome')).toBe('2030-03-31T02:00:00.000Z');
    });

    it('la "Z" finale prevale sul TZID', () => {
        expect(parseIcalDateTime('20300115T090000Z', 'America/New_York')).toBe('2030-01-15T09:00:00.000Z');
    });

    it('con un TZID non riconosciuto (es. nomi Windows) usa l’ora locale', () => {
        expect(new Date(parseIcalDateTime('20300115T090000', 'W. Europe Standard Time')).getHours()).toBe(9);
        expect(zonedTimeToUtc(2030, 0, 15, 9, 0, 'Fuso/Inesistente')).toBeNull();
    });
});

describe('lettura delle righe iCal', () => {
    it('ricompone le righe ripiegate con spazio o tab e normalizza i fine riga', () => {
        expect(unfoldIcalLines('SUMMARY:Tratta\r\n mento\r\n\tlungo\rUID:1\nEND:VEVENT')).toEqual(['SUMMARY:Trattamento' + 'lungo', 'UID:1', 'END:VEVENT']);
    });

    it('separa nome, parametri e valore', () => {
        expect(parseIcalProperty('DTSTART;TZID=Europe/Rome:20300115T090000')).toEqual({ name: 'DTSTART', params: { TZID: 'Europe/Rome' }, value: '20300115T090000' });
        expect(parseIcalProperty('summary;LANGUAGE=it:Visita: controllo')).toEqual({ name: 'SUMMARY', params: { LANGUAGE: 'it' }, value: 'Visita: controllo' });
    });

    it('rispetta i parametri tra virgolette che contengono ":"', () => {
        expect(parseIcalProperty('DTSTART;TZID="Europe/Rome:x":20300115T090000')).toEqual({ name: 'DTSTART', params: { TZID: 'Europe/Rome:x' }, value: '20300115T090000' });
    });

    it('restituisce null per righe senza ":"', () => {
        expect(parseIcalProperty('riga-non-valida')).toBeNull();
    });

    it('decodifica i caratteri con escape', () => {
        expect(unescapeIcalText('Rossi\\, Mario\\; nota\\nseconda riga\\\\fine')).toBe('Rossi, Mario; nota\nseconda riga\\fine');
    });
});

describe('normalizeGoogleCalendarUrl (client)', () => {
    it.each([
        ['https://example.com/cal.ics', 'https://example.com/cal.ics'],
        ['https://calendar.google.com/calendar/ical/x%40gmail.com/public/basic.ics', 'https://calendar.google.com/calendar/ical/x%40gmail.com/public/basic.ics'],
        ['https://calendar.google.com/calendar/u/0?cid=c2lsdmlhY2hpbmVAZ21haWwuY29t', 'https://calendar.google.com/calendar/ical/silviachine@gmail.com/public/basic.ics'],
        ['https://calendar.google.com/calendar/r?cid=abc123%40group.calendar.google.com', 'https://calendar.google.com/calendar/ical/abc123@group.calendar.google.com/public/basic.ics'],
        ['non è un url', 'non è un url']
    ])('%s → %s', (input, expected) => {
        expect(normalizeGoogleCalendarUrl(input)).toBe(expected);
    });
});

describe('coerenza tra normalizzazione client e server', () => {
    const samples = [
        'https://example.com/cal.ics',
        'https://calendar.google.com/calendar/u/0?cid=c2lsdmlhY2hpbmVAZ21haWwuY29t',
        'https://calendar.google.com/calendar/r?cid=YWJjMTIzQGdyb3VwLmNhbGVuZGFyLmdvb2dsZS5jb20=',
        'https://calendar.google.com/calendar/r?cid=abc123%40group.calendar.google.com',
        'https://calendar.google.com/calendar/embed?src=abc'
    ];

    it.each(samples)('producono lo stesso URL per %s', async (url) => {
        const fetchMock = vi.fn().mockResolvedValue(new Response('BEGIN:VCALENDAR\nEND:VCALENDAR'));
        vi.stubGlobal('fetch', fetchMock);
        vi.spyOn(console, 'log').mockImplementation(() => {});
        await handler(createMockReq({ query: { url } }), createMockRes());
        vi.unstubAllGlobals();
        expect(fetchMock.mock.calls[0][0]).toBe(normalizeGoogleCalendarUrl(url));
    });
});
