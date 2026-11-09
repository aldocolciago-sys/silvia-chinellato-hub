/**
 * Sincronizzazione dei calendari iCal (poliambulatori, turni, calendari personali) con l'agenda.
 *
 * Logica pura, senza Firebase né rete, usata da due parti:
 *  - l'app (index.html), quando Silvia accede o preme "Sincronizza";
 *  - il server (api/calendar-sync.js), ogni ora e prima del riepilogo delle 7.
 * Così il risultato è lo stesso da qualunque parte parta la sincronizzazione.
 *
 * Regole principali:
 *  - gli appuntamenti nuovi vengono aggiunti, quelli modificati aggiornati senza perdere i dati
 *    inseriti a mano (paziente, compenso, pagamento, note);
 *  - un appuntamento sparito dal calendario originale NON viene mai tolto: viene segnato
 *    "da decidere" (extendedProps.externalRemovalPending) e sarà Silvia a scegliere se tenerlo o toglierlo;
 *  - se un calendario non si scarica, i suoi appuntamenti restano come sono;
 *  - con `guardMassRemoval` (sincronizzazione automatica) se da un calendario spariscono in blocco
 *    molti appuntamenti futuri non si segna nulla: quasi sempre è un problema del calendario.
 */

export const DEFAULT_TIME_ZONE = 'Europe/Rome';
export const ICAL_ID_PREFIX = 'ical_';
/** Sparizioni in blocco: almeno 5 appuntamenti futuri e almeno metà di quelli futuri della sede. */
export const MASS_REMOVAL_MIN = 5;
export const MASS_REMOVAL_RATIO = 0.5;
const STATUS_NOTE_PATTERN = /\n?\[STATO CALENDARIO\][^\n]*/g;
const TREATMENTS = ['osteopatia', 'idrocolonterapia'];

// ---------------------------------------------------------------------------
// Lettura del formato iCal (RFC 5545)
// ---------------------------------------------------------------------------

/** Converte i link di condivisione di Google Calendar nell'indirizzo .ics pubblico. */
export function normalizeGoogleCalendarUrl(url) {
    try {
        const urlObj = new URL(url);
        if (!url.includes('calendar.google.com')) return url;
        const cid = urlObj.searchParams.get('cid');
        if (!cid) return url;
        let calendarId = cid;
        try {
            const decoded = atob(cid);
            if (decoded && decoded.includes('@')) calendarId = decoded;
        } catch (e) { /* non era base64 */ }
        calendarId = decodeURIComponent(calendarId);
        return `https://calendar.google.com/calendar/ical/${calendarId}/public/basic.ics`;
    } catch (e) {
        return url;
    }
}

/** Ricompone le righe ripiegate (RFC 5545 §3.1): una riga che inizia con spazio o tab continua la precedente. */
export function unfoldIcalLines(text) {
    return String(text || '').replace(/\r\n|\r/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

/** Scompone una riga iCal in nome, parametri (es. TZID) e valore, rispettando i parametri tra virgolette. */
export function parseIcalProperty(line) {
    let inQuotes = false;
    let colon = -1;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') inQuotes = !inQuotes;
        else if (ch === ':' && !inQuotes) { colon = i; break; }
    }
    if (colon < 0) return null;
    const [name, ...paramParts] = line.slice(0, colon).split(';');
    const params = {};
    for (const part of paramParts) {
        const eq = part.indexOf('=');
        if (eq > 0) params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, '');
    }
    return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

/** Decodifica i caratteri con escape dei valori di testo iCal (\\ \; \, \n). */
export function unescapeIcalText(value) {
    return String(value || '').replace(/\\([\\;,nN])/g, (m, ch) => (ch === 'n' || ch === 'N') ? '\n' : ch);
}

/** Converte un orario "da parete" in un fuso IANA (es. Europe/Rome) nell'istante UTC corrispondente. */
export function zonedTimeToUtc(year, month, day, hour, minute, timeZone) {
    try {
        const formatter = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const offsetAt = (ts) => {
            const parts = formatter.formatToParts(new Date(ts));
            const get = (type) => Number(parts.find(p => p.type === type).value);
            return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - ts;
        };
        const wallClock = Date.UTC(year, month, day, hour, minute);
        let ts = wallClock - offsetAt(wallClock);
        ts = wallClock - offsetAt(ts);
        return new Date(ts);
    } catch (e) {
        return null;
    }
}

/**
 * Istante ISO di un DTSTART/DTEND.
 * - con la Z: UTC;
 * - con TZID: in quel fuso (se il fuso non è riconosciuto, ora di Roma);
 * - "floating" (senza Z né TZID): ora di Roma;
 * - solo data (VALUE=DATE, giornata intera): convenzionalmente alle 09:00 UTC.
 * Restituisce null se il valore non è una data: l'evento viene ignorato.
 */
export function parseIcalDateTime(str, tzid = null, fallbackTimeZone = DEFAULT_TIME_ZONE) {
    const raw = String(str || '').trim();
    const clean = raw.replace(/[^0-9T]/g, '');
    if (!/^\d{8}/.test(clean)) return null;
    const year = parseInt(clean.substring(0, 4), 10);
    const month = parseInt(clean.substring(4, 6), 10) - 1;
    const day = parseInt(clean.substring(6, 8), 10);
    if (!(clean.length >= 13 && clean.charAt(8) === 'T')) {
        const date = new Date(Date.UTC(year, month, day, 9, 0));
        return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
    const hour = parseInt(clean.substring(9, 11), 10);
    const minute = parseInt(clean.substring(11, 13), 10);
    let date = null;
    if (/Z$/i.test(raw)) date = new Date(Date.UTC(year, month, day, hour, minute));
    else {
        if (tzid) date = zonedTimeToUtc(year, month, day, hour, minute, tzid);
        if (!date || Number.isNaN(date.getTime())) date = zonedTimeToUtc(year, month, day, hour, minute, fallbackTimeZone);
    }
    return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

/**
 * Eventi (VEVENT) di un calendario iCal. Le proprietà dei componenti annidati (es. VALARM)
 * vengono ignorate, così il titolo di un allarme non sostituisce quello dell'appuntamento.
 */
export function parseIcsEvents(text) {
    const events = [];
    let current = null;
    let depth = 0;
    for (const line of unfoldIcalLines(text)) {
        if (!current) {
            if (line.startsWith('BEGIN:VEVENT')) { current = { uid: null, recurrenceId: null, summary: null, start: null, startTzid: null, end: null, endTzid: null, status: null }; depth = 0; }
            continue;
        }
        if (line.startsWith('END:VEVENT') && depth === 0) {
            if (current.uid || current.summary || current.start) events.push(current);
            current = null;
            continue;
        }
        if (line.startsWith('BEGIN:')) { depth++; continue; }
        if (line.startsWith('END:')) { depth = Math.max(0, depth - 1); continue; }
        if (depth > 0) continue;
        const prop = parseIcalProperty(line);
        if (!prop) continue;
        if (prop.name === 'UID') current.uid = prop.value.trim() || null;
        else if (prop.name === 'SUMMARY') current.summary = unescapeIcalText(prop.value).trim();
        else if (prop.name === 'DTSTART') { current.start = prop.value.trim(); current.startTzid = prop.params.TZID || null; }
        else if (prop.name === 'DTEND') { current.end = prop.value.trim(); current.endTzid = prop.params.TZID || null; }
        else if (prop.name === 'RECURRENCE-ID') current.recurrenceId = prop.value.trim() || null;
        else if (prop.name === 'STATUS') current.status = prop.value.trim().toUpperCase();
    }
    return events;
}

function hashText(text) {
    let hash = 0x811c9dc5;
    for (const ch of String(text)) {
        hash ^= ch.codePointAt(0);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

/**
 * Id dell'appuntamento in agenda: `ical_<sede>_<UID>`.
 * - le eccezioni di una serie (RECURRENCE-ID, stesso UID) hanno un id proprio, così non si
 *   sovrascrivono a vicenda a ogni sincronizzazione;
 * - senza UID l'id deriva da titolo e inizio, quindi resta lo stesso tra una sincronizzazione e l'altra;
 * - le "/" diventano "_" perché in Firestore separano i percorsi.
 */
export function icalEventId(centerId, item) {
    const uid = item.uid || `nouid-${hashText(`${item.summary || ''}|${item.start || ''}`)}`;
    const suffix = item.recurrenceId ? `_r${String(item.recurrenceId).replace(/[^0-9TZ]/gi, '')}` : '';
    return `${ICAL_ID_PREFIX}${centerId}_${uid}${suffix}`.replace(/\//g, '_');
}

export function isValidCalendarText(text) {
    return typeof text === 'string' && (text.includes('BEGIN:VCALENDAR') || text.includes('BEGIN:VEVENT'));
}

// ---------------------------------------------------------------------------
// Compenso predefinito (stesse regole di defaultFeeForEvent in index.html)
// ---------------------------------------------------------------------------

function normalizeText(value) {
    return String(value || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function detectTreatmentInText(text) {
    const t = normalizeText(text);
    if (/idrocolon|colon/.test(t)) return 'idrocolonterapia';
    if (/osteo/.test(t)) return 'osteopatia';
    return null;
}

/** Trattamento: quello scelto a mano, altrimenti dal titolo, dal servizio e dal nome della sede. */
export function eventTreatment(event, center) {
    if (TREATMENTS.includes(event?.extendedProps?.treatment)) return event.extendedProps.treatment;
    for (const text of [event?.title, center?.service, event?.extendedProps?.centerName, center?.name]) {
        const found = detectTreatmentInText(text);
        if (found) return found;
    }
    return null;
}

function roundEuro(value) {
    return Math.round(Number(value || 0) * 100) / 100;
}

function durationHours(event) {
    const start = new Date(event?.start).getTime();
    const end = new Date(event?.end).getTime();
    if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return 0;
    return Math.round(((end - start) / 3600000) * 100) / 100;
}

/** Compenso predefinito di un appuntamento importato: turni a ore, tariffa del trattamento, 0 per i calendari personali. */
export function defaultIcalFee(event, center) {
    if (!center) return 0;
    if (center.isNonClinicalCalendar === true && center.isShiftCalendar === true) return roundEuro(durationHours(event) * Number(center.hourlyRate || 0));
    if (event?.extendedProps?.isNonClinical === true || center.isNonClinicalCalendar === true) return 0;
    const rates = { osteopatia: Number(center.rateOsteopatia || 0), idrocolonterapia: Number(center.rateIdrocolonterapia || 0) };
    const treatment = eventTreatment(event, center);
    if (treatment && rates[treatment] > 0) return roundEuro(rates[treatment]);
    const distinct = [...new Set(Object.values(rates).filter(v => v > 0))];
    return distinct.length === 1 ? roundEuro(distinct[0]) : 0;
}

// ---------------------------------------------------------------------------
// Confronto tra calendari e agenda
// ---------------------------------------------------------------------------

/** Tipo di calendario della sede: turni a ore, calendario personale o sede clinica. */
export function centerKind(center) {
    if (center?.isNonClinicalCalendar === true && center?.isShiftCalendar === true) return 'shift';
    if (center?.isNonClinicalCalendar === true) return 'personal';
    return 'clinical';
}

function matchPatientId(title, patients) {
    const text = String(title || '').toLowerCase();
    for (const p of patients || []) {
        const name = String(p?.name || '').trim().toLowerCase();
        if (name && text.includes(name)) return p.id;
    }
    return null;
}

function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
    return JSON.stringify(value ?? null);
}

/** Campi cambiati tra due versioni di un evento, come percorsi Firestore ("title", "extendedProps.fee"). */
export function eventPatch(before, after) {
    const patch = {};
    const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
    for (const key of keys) {
        if (key === 'extendedProps') continue;
        if (stableStringify(before?.[key]) !== stableStringify(after?.[key])) patch[key] = after?.[key] ?? null;
    }
    const beforeProps = before?.extendedProps || {};
    const afterProps = after?.extendedProps || {};
    for (const key of new Set([...Object.keys(beforeProps), ...Object.keys(afterProps)])) {
        if (stableStringify(beforeProps[key]) !== stableStringify(afterProps[key])) patch[`extendedProps.${key}`] = afterProps[key] ?? null;
    }
    return patch;
}

function snapshot(event) {
    const props = event?.extendedProps || {};
    return {
        id: event.id,
        title: event.title || '',
        start: event.start || null,
        end: event.end || null,
        centerId: props.centerId ?? null,
        centerName: props.centerName || '',
        patientId: props.patientId ?? null,
        treatment: props.treatment ?? null
    };
}

/**
 * Confronta i calendari scaricati con gli appuntamenti in agenda.
 *
 * @param {object} input
 * @param {object[]} input.centers sedi (solo quelle con icalUrl vengono sincronizzate)
 * @param {object[]} input.events appuntamenti in agenda (tutti, o quelli da `windowStart` in poi)
 * @param {object[]} [input.patients] anagrafica, per associare i pazienti dal titolo
 * @param {Record<string, string|null>} input.feeds testo .ics per id sede; null = download non riuscito
 * @param {Date} [input.now]
 * @param {(event: object, center: object) => number} [input.feeFor] compenso predefinito
 * @param {boolean} [input.guardMassRemoval] non segna le sparizioni in blocco (sincronizzazione automatica)
 * @param {string|null} [input.windowStart] ISO: ignora gli eventi del calendario che iniziano prima
 *        e che non sono tra `events` (il server legge solo gli appuntamenti recenti)
 * @returns {{ writes: {id: string, data: object, patch: object, isNew: boolean}[], changes: object[], centers: object[], failed: string[], suspicious: object[] }}
 */
export function computeCalendarSync({ centers = [], events = [], patients = [], feeds = {}, now = new Date(), feeFor = defaultIcalFee, guardMassRemoval = false, windowStart = null } = {}) {
    const nowIso = now.toISOString();
    const nowMs = now.getTime();
    const byId = new Map(events.filter(ev => ev?.id).map(ev => [ev.id, ev]));
    const writes = [];
    const changes = [];
    const centerResults = [];
    const failed = [];
    const suspicious = [];

    for (const center of centers.filter(c => String(c?.icalUrl || '').trim())) {
        const result = { id: center.id, name: center.name, ok: false, added: 0, modified: 0, removed: 0, restored: 0, suspicious: false };
        centerResults.push(result);
        const text = feeds[center.id];
        if (!isValidCalendarText(text)) {
            failed.push(center.name);
            continue;
        }
        result.ok = true;
        const kind = centerKind(center);
        const nonClinical = center.isNonClinicalCalendar === true;
        const color = center.color || '#3f5e4e';

        const items = new Map();
        for (const item of parseIcsEvents(text)) {
            if (item.status === 'CANCELLED') continue;
            const start = parseIcalDateTime(item.start, item.startTzid);
            if (!start) continue;
            let end = item.end ? parseIcalDateTime(item.end, item.endTzid) : null;
            if (!end) end = new Date(new Date(start).getTime() + 3600000).toISOString();
            items.set(icalEventId(center.id, item), { title: item.summary || 'Appuntamento', start, end });
        }

        for (const [id, item] of items) {
            const existing = byId.get(id) || null;
            if (!existing && windowStart && item.start < windowStart) continue;
            const props = { ...(existing?.extendedProps || {}) };
            const wasPending = props.externalRemovalPending === true;
            const wasDetached = props.detachedFromExternal === true;
            props.centerId = center.id;
            props.centerName = center.name;
            props.patientId = nonClinical ? null : (props.patientId || matchPatientId(item.title, patients));
            props.isNonClinical = nonClinical;
            if (wasPending) { props.externalRemovalPending = false; props.externalRemovalDetectedAt = null; }
            if (wasDetached) {
                // Mantenuto da Silvia e poi ricomparso nel calendario originale: torna sincronizzato, con tutti i suoi dati.
                props.detachedFromExternal = false;
                props.externalCalendarStatus = null;
                props.externalRemovedAt = null;
                if (typeof props.notes === 'string') props.notes = props.notes.replace(STATUS_NOTE_PATTERN, '').trim();
            }
            const event = { ...(existing || {}), id, title: item.title, start: item.start, end: item.end, backgroundColor: color, borderColor: color, textColor: '#ffffff', extendedProps: props };
            if (!(Number(props.fee || 0) > 0)) {
                const autoFee = Number(feeFor ? feeFor(event, center) : 0) || 0;
                if (autoFee > 0) props.fee = autoFee;
            }

            if (!existing) {
                writes.push({ id, data: event, patch: eventPatch({}, event), isNew: true });
                changes.push({ type: 'added', kind, ...snapshot(event) });
                result.added++;
                continue;
            }
            const patch = eventPatch(existing, event);
            if (Object.keys(patch).length) writes.push({ id, data: event, patch, isNew: false });
            const timeChanged = existing.title !== event.title || existing.start !== event.start || existing.end !== event.end;
            const before = { title: existing.title || '', start: existing.start || null, end: existing.end || null };
            if (wasPending) {
                changes.push({ type: 'restored', kind, ...snapshot(event), ...(timeChanged ? { before } : {}) });
                result.restored++;
            } else if (timeChanged) {
                changes.push({ type: 'modified', kind, ...snapshot(event), before });
                result.modified++;
            }
        }

        // Appuntamenti della sede spariti dal calendario originale.
        const own = events.filter(ev => ev?.id?.startsWith(ICAL_ID_PREFIX) && String(ev.extendedProps?.centerId ?? '') === String(center.id) && ev.extendedProps?.detachedFromExternal !== true);
        const missing = own.filter(ev => !items.has(ev.id) && ev.extendedProps?.externalRemovalPending !== true);
        if (guardMassRemoval && missing.length) {
            const isFuture = ev => new Date(ev.start).getTime() >= nowMs;
            const futureOwn = own.filter(isFuture).length;
            const futureMissing = missing.filter(isFuture).length;
            if ((items.size === 0 && futureOwn > 0) || (futureMissing >= MASS_REMOVAL_MIN && futureMissing >= futureOwn * MASS_REMOVAL_RATIO)) {
                result.suspicious = true;
                suspicious.push({ centerId: center.id, name: center.name, count: futureMissing || missing.length });
                continue;
            }
        }
        for (const ev of missing) {
            const data = { ...ev, extendedProps: { ...(ev.extendedProps || {}), externalRemovalPending: true, externalRemovalDetectedAt: nowIso } };
            writes.push({ id: ev.id, data, patch: { 'extendedProps.externalRemovalPending': true, 'extendedProps.externalRemovalDetectedAt': nowIso }, isNew: false });
            changes.push({ type: 'removed', kind, ...snapshot(ev) });
            result.removed++;
        }
    }

    return { writes, changes, centers: centerResults, failed, suspicious };
}

/** Appuntamenti spariti dal calendario originale in attesa della scelta di Silvia, dal più vicino. */
export function pendingRemovalEvents(events = []) {
    return events
        .filter(ev => ev?.extendedProps?.externalRemovalPending === true && ev.extendedProps?.detachedFromExternal !== true)
        .sort((a, b) => String(a.start || '').localeCompare(String(b.start || '')));
}

/** Aggiunge le novità al registro (ultimi `days` giorni, al massimo `max` voci, dalla più recente). */
export function appendRecentChanges(previous = [], changes = [], { now = new Date(), days = 14, max = 200 } = {}) {
    const at = now.toISOString();
    const cutoff = now.getTime() - days * 86400000;
    const fresh = changes.map(change => ({ ...change, at }));
    return [...fresh, ...(Array.isArray(previous) ? previous : [])]
        .filter(item => item && new Date(item.at).getTime() >= cutoff)
        .slice(0, max);
}
