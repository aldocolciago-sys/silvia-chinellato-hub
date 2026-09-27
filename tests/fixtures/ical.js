/** Calendari iCal di esempio usati da unit, integrazione ed E2E. */

export function vevent({ uid, summary, start, end, extra = [] }) {
    return [
        'BEGIN:VEVENT',
        uid ? `UID:${uid}` : null,
        summary ? `SUMMARY:${summary}` : null,
        start ? `DTSTART:${start}` : null,
        end ? `DTEND:${end}` : null,
        ...extra,
        'END:VEVENT'
    ].filter(Boolean).join('\r\n');
}

export function vcalendar(events = []) {
    return [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Test//Silvia Chinellato Hub//IT',
        ...events,
        'END:VCALENDAR'
    ].join('\r\n');
}

export const SIMPLE_CALENDAR = vcalendar([
    vevent({ uid: 'a1@test', summary: 'Mario Rossi', start: '20300115T090000Z', end: '20300115T100000Z' }),
    vevent({ uid: 'a2@test', summary: 'Giulia Bianchi', start: '20300116T140000Z', end: '20300116T150000Z' })
]);

export const HTML_LOGIN_PAGE = '<!DOCTYPE html><html><head><title>Google Calendar - Sign in</title></head><body>Accedi</body></html>';
