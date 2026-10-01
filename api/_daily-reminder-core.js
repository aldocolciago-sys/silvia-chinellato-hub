/**
 * Riepilogo mattutino degli appuntamenti per il WhatsApp di Silvia.
 * Logica pura (senza Firebase né rete), condivisa dalla funzione serverless e dai test.
 * Stesse regole della finestra "Promemoria di oggi e domani" dell'app.
 */
export const TIME_ZONE = 'Europe/Rome';
export const SEND_FROM_HOUR = 7;
export const MAX_LINES_PER_DAY = 25;

const TREATMENT_LABELS = { osteopatia: 'Osteopatia', idrocolonterapia: 'Idrocolonterapia' };

const partsFormatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
const dayLabelFormatter = new Intl.DateTimeFormat('it-IT', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });

/** Data e ora di Roma di un istante. */
export function romeParts(date) {
    const p = Object.fromEntries(partsFormatter.formatToParts(date).map(part => [part.type, part.value]));
    return { year: Number(p.year), month: Number(p.month), day: Number(p.day), hour: Number(p.hour), minute: Number(p.minute) };
}

function pad(value) {
    return String(value).padStart(2, '0');
}

export function romeDayKey(date) {
    const p = romeParts(date);
    return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function addDaysToKey(key, days) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** "mercoledì 1 ottobre" per una chiave AAAA-MM-GG. */
export function dayLabel(key) {
    const [y, m, d] = key.split('-').map(Number);
    return dayLabelFormatter.format(new Date(Date.UTC(y, m - 1, d, 12)));
}

/** Istante corrispondente a un orario "da orologio" di Roma (gestisce ora legale e solare). */
export function romeWallTimeToDate(year, month, day, hour, minute) {
    const wall = Date.UTC(year, month - 1, day, hour, minute);
    let guess = wall;
    for (let i = 0; i < 2; i++) {
        const p = romeParts(new Date(guess));
        guess += wall - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    }
    return new Date(guess);
}

/**
 * Inizio di un appuntamento. Gli appuntamenti dello studio sono salvati come orario
 * senza fuso ("2026-10-01T09:00:00", ora di Roma); quelli sincronizzati hanno la Z o l'offset.
 */
export function parseEventStart(value) {
    const raw = String(value || '').trim();
    const local = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(raw);
    if (local) {
        const [, y, mo, d, h, mi] = local.map(Number);
        return romeWallTimeToDate(y, mo, d, h, mi);
    }
    const date = new Date(raw);
    return raw && !Number.isNaN(date.getTime()) ? date : null;
}

export function normalizeWhatsAppNumber(phone) {
    const raw = String(phone || '').trim();
    const hasPlus = raw.startsWith('+');
    let digits = raw.replace(/\D/g, '');
    if (!digits) return '';
    if (!hasPlus && digits.startsWith('00')) digits = digits.slice(2);
    else if (!hasPlus && /^[03]\d{5,10}$/.test(digits)) digits = '39' + digits;
    return digits.length >= 8 && digits.length <= 15 ? digits : '';
}

/** "Maria Rossi" → "M.R.": il nome completo non esce dall'app. */
export function initials(name) {
    const letters = String(name || '').split(/[\s-]+/).map(word => [...word.replace(/[^\p{L}]/gu, '')][0]).filter(Boolean);
    return letters.length ? letters.map(letter => `${letter.toUpperCase()}.`).join('') : '?';
}

function normalizeText(value) {
    return String(value || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function detectTreatmentInText(text) {
    const t = normalizeText(text);
    if (/idrocolon|colon/.test(t)) return 'idrocolonterapia';
    if (/osteo/.test(t)) return 'osteopatia';
    return null;
}

function eventCenter(ev, centers) {
    const id = String(ev?.extendedProps?.centerId || '');
    return centers.find(center => String(center.id) === id) || null;
}

function eventTreatment(ev, center) {
    if (TREATMENT_LABELS[ev?.extendedProps?.treatment]) return ev.extendedProps.treatment;
    for (const text of [ev?.title, center?.service, ev?.extendedProps?.centerName, center?.name]) {
        const found = detectTreatmentInText(text);
        if (found) return found;
    }
    return null;
}

/** Appuntamenti clinici di un giorno di Roma: esclusi giornate intere, calendari non clinici, turni e annullati. */
export function appointmentsForDay({ events = [], patients = [], centers = [] }, dayKey, notBefore = null) {
    return events
        .filter(ev => ev && !ev.allDay && ev.extendedProps?.paymentStatus !== 'cancelled')
        .map(ev => ({ ev, center: eventCenter(ev, centers), start: parseEventStart(ev.start) }))
        .filter(({ ev, center, start }) => start && ev.extendedProps?.isNonClinical !== true && center?.isNonClinicalCalendar !== true
            && romeDayKey(start) === dayKey && (!notBefore || start >= notBefore))
        .sort((a, b) => a.start - b.start)
        .map(({ ev, center, start }) => {
            const patient = patients.find(p => String(p.id) === String(ev.extendedProps?.patientId || '')) || null;
            const centerName = ev.extendedProps?.centerName || center?.name;
            const p = romeParts(start);
            return {
                time: `${pad(p.hour)}:${pad(p.minute)}`,
                who: patient ? initials(patient.name) : 'senza paziente',
                treatment: TREATMENT_LABELS[eventTreatment(ev, center)] || null,
                place: centerName && centerName !== 'Studio Privato' ? centerName : 'studio',
                hasPatient: Boolean(patient),
                hasPhone: Boolean(patient && normalizeWhatsAppNumber(patient.phone)),
                reminderSent: Boolean(ev.extendedProps?.reminderSentAt)
            };
        });
}

function plural(count, one, many) {
    return `${count} ${count === 1 ? one : many}`;
}

function sectionLines(title, items) {
    if (!items.length) return [`*${title}*: nessun appuntamento con pazienti.`];
    const lines = [`*${title}* (${items.length})`];
    for (const item of items.slice(0, MAX_LINES_PER_DAY)) {
        const parts = [item.time, item.who, item.treatment, item.place].filter(Boolean);
        const flag = !item.hasPatient ? '' : !item.hasPhone ? ' ⚠️ senza telefono' : '';
        lines.push(`• ${parts.join(' – ')}${flag}`);
    }
    if (items.length > MAX_LINES_PER_DAY) lines.push(`…e altri ${items.length - MAX_LINES_PER_DAY}`);
    return lines;
}

/**
 * Testo del riepilogo: appuntamenti di oggi (non ancora iniziati) e di domani,
 * con le sole iniziali dei pazienti, più il conteggio dei promemoria da inviare.
 */
export function buildDigest(data, now, { appUrl = '', test = false } = {}) {
    const todayKey = romeDayKey(now);
    const tomorrowKey = addDaysToKey(todayKey, 1);
    const today = appointmentsForDay(data, todayKey, now);
    const tomorrow = appointmentsForDay(data, tomorrowKey);
    const all = [...today, ...tomorrow];
    const pending = all.filter(item => item.hasPhone && !item.reminderSent).length;
    const noPhone = all.filter(item => item.hasPatient && !item.hasPhone).length;
    const noPatient = all.filter(item => !item.hasPatient).length;

    const lines = [];
    if (test) lines.push('🧪 Messaggio di prova', '');
    lines.push(`☀️ Buongiorno Silvia! Oggi è ${dayLabel(todayKey)}.`, '');
    lines.push(...sectionLines('Oggi', today), '');
    lines.push(...sectionLines(`Domani, ${dayLabel(tomorrowKey)}`, tomorrow));
    const todo = [];
    if (pending) todo.push(`📲 ${pending} promemoria da inviare ai pazienti`);
    if (noPhone) todo.push(`⚠️ ${plural(noPhone, 'paziente', 'pazienti')} senza telefono`);
    if (noPatient) todo.push(`⚠️ ${plural(noPatient, 'appuntamento', 'appuntamenti')} senza paziente associato`);
    if (todo.length) lines.push('', ...todo);
    if (appUrl) lines.push('', `Apri l'agenda: ${appUrl}`);
    return { text: lines.join('\n'), todayKey, counts: { today: today.length, tomorrow: tomorrow.length, pending, noPhone, noPatient } };
}
