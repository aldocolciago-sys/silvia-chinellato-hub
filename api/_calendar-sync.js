import {
    appendRecentChanges, computeCalendarSync, defaultIcalFee, isValidCalendarText, normalizeGoogleCalendarUrl
} from '../lib/calendar-sync-core.js';
import {
    TREATMENT_LABELS, addDaysToKey, eventCenter, eventKind, eventTreatment, initials, romeDayKey, romeParts, romeWallTimeToDate, TIME_ZONE
} from './_daily-reminder-core.js';
import { firebaseAdmin, sendCallMeBot, sharedRoot } from './_shared.js';
import { fetchPublicUrl } from './ical.js';

/**
 * Sincronizzazione automatica dei calendari (ogni ora e prima del riepilogo delle 7) e
 * avviso WhatsApp a Silvia quando cambia qualcosa nei poliambulatori o nei turni.
 *
 * - Legge solo gli appuntamenti da due giorni fa in poi (poche letture Firestore a ogni ora).
 * - Gli appuntamenti spariti dal calendario originale restano in agenda, segnati "da decidere":
 *   la scelta se tenerli o toglierli la fa Silvia nell'app.
 * - Un "lucchetto" in settings/calendar_sync evita che due sincronizzazioni contemporanee
 *   (cron orario e riepilogo delle 7) mandino due volte lo stesso avviso.
 * - Se l'invio WhatsApp non riesce, le novità restano in coda e partono alla sincronizzazione dopo.
 * - Le novità dei calendari personali aggiornano l'agenda ma non generano avvisi.
 */
export const LOCK_TTL_MS = 3 * 60 * 1000;
export const LOCK_RETRIES = 3;
export const LOCK_RETRY_MS = 10000;
export const WINDOW_DAYS_BACK = 2;
export const MAX_ALERT_LINES = 20;
export const OUTBOX_MAX = 60;
const DOWNLOAD_TIMEOUT_MS = 15000;
const WRITE_CHUNK = 20;

const weekdayFormatter = new Intl.DateTimeFormat('it-IT', { timeZone: TIME_ZONE, weekday: 'short' });

function pad(value) {
    return String(value).padStart(2, '0');
}

function romeDayStart(key) {
    const [y, m, d] = key.split('-').map(Number);
    return romeWallTimeToDate(y, m, d, 0, 0);
}

/** Inizio (mezzanotte di Roma) della finestra di appuntamenti letti dal server. */
export function syncWindowStart(now) {
    return romeDayStart(addDaysToKey(romeDayKey(now), -WINDOW_DAYS_BACK)).toISOString();
}

/** Avvisi attivi se scelti nell'app, altrimenti insieme al riepilogo delle 7 (stessa regola dell'app). */
export function syncAlertsEnabled(settings) {
    return settings?.syncAlertsEnabled === true || (settings?.syncAlertsEnabled === undefined && settings?.dailyDigestEnabled === true);
}

/** Novità che meritano un WhatsApp: poliambulatori e turni, da oggi in poi. */
export function alertableChanges(changes, now) {
    const todayStart = romeDayStart(romeDayKey(now)).getTime();
    return changes.filter(change => (change.kind === 'clinical' || change.kind === 'shift')
        && [change.start, change.before?.start].some(value => value && new Date(value).getTime() >= todayStart));
}

/** Unisce la coda non inviata con le nuove novità: per lo stesso appuntamento e tipo vale l'ultima. */
export function mergeOutbox(outbox = [], fresh = []) {
    const map = new Map();
    for (const change of [...outbox, ...fresh]) {
        const key = `${change.type}:${change.id}`;
        map.delete(key);
        map.set(key, change);
    }
    return [...map.values()].slice(-OUTBOX_MAX);
}

function clock(date) {
    const p = romeParts(date);
    return `${pad(p.hour)}:${pad(p.minute)}`;
}

function shortDay(date) {
    const p = romeParts(date);
    return `${weekdayFormatter.format(date).replace('.', '')} ${p.day}/${p.month}`;
}

function timeText(start, end, withEnd) {
    return withEnd && end && end > start ? `${clock(start)}–${clock(end)}` : clock(start);
}

/** "M.R. – Osteopatia – CMS Carate" o "🩺 Turno – Medicina dello Sport": mai il nome completo del paziente. */
function changeSubject(change, { patients, centers }) {
    const ev = { title: change.title, extendedProps: { centerId: change.centerId, centerName: change.centerName, patientId: change.patientId, treatment: change.treatment } };
    const center = eventCenter(ev, centers);
    const centerName = change.centerName || center?.name || '';
    if (change.kind === 'shift' || eventKind(ev, center) === 'shift') return ['🩺 Turno', centerName].filter(Boolean).join(' – ');
    const patient = patients.find(p => String(p.id) === String(change.patientId || '')) || null;
    const who = patient ? initials(patient.name) : 'senza paziente';
    const treatment = TREATMENT_LABELS[eventTreatment(ev, center)] || null;
    const place = centerName && centerName !== 'Studio Privato' ? centerName : 'studio';
    return [who, treatment, place].filter(Boolean).join(' – ');
}

function changeLine(change, context) {
    const withEnd = change.kind === 'shift';
    const subject = changeSubject(change, context);
    const start = new Date(change.start);
    const end = change.end ? new Date(change.end) : null;
    const before = change.before;
    if (!before) return `• ${shortDay(start)} ${timeText(start, end, withEnd)} – ${subject}`;
    const oldStart = new Date(before.start);
    const oldEnd = before.end ? new Date(before.end) : null;
    const startChanged = before.start !== change.start;
    const endChanged = before.end !== change.end;
    if (!startChanged && !endChanged) {
        const note = change.kind === 'clinical' ? 'titolo cambiato, controlla il paziente' : 'titolo cambiato';
        return `• ${shortDay(start)} ${timeText(start, end, withEnd)} – ${subject} (${note})`;
    }
    const ranges = withEnd || !startChanged;
    const from = timeText(oldStart, oldEnd, ranges);
    const to = timeText(start, end, ranges);
    const when = romeDayKey(oldStart) === romeDayKey(start)
        ? `${shortDay(start)} ${from} → ${to}`
        : `${shortDay(oldStart)} ${from} → ${shortDay(start)} ${to}`;
    return `• ${when} – ${subject}`;
}

const SECTIONS = [
    { type: 'removed', title: '❌ *Cancellati dal calendario originale*', footer: 'Restano in agenda finché non scegli se tenerli o toglierli: apri l\'app → Ultime novità.' },
    { type: 'modified', title: '✏️ *Modificati*' },
    { type: 'added', title: '➕ *Nuovi*' },
    { type: 'restored', title: '↩️ *Di nuovo nel calendario originale* (non serve scegliere)' }
];

/** Testo del WhatsApp con le novità dell'agenda (al massimo MAX_ALERT_LINES appuntamenti). */
export function buildChangeMessage({ changes = [], suspicious = [], patients = [], centers = [], appUrl = '' }) {
    const context = { patients, centers };
    const lines = ['🔄 *Agenda aggiornata*'];
    let budget = MAX_ALERT_LINES;
    let hidden = 0;
    for (const section of SECTIONS) {
        const items = changes.filter(change => change.type === section.type).sort((a, b) => String(a.start).localeCompare(String(b.start)));
        if (!items.length) continue;
        lines.push('', `${section.title} (${items.length})`);
        const shown = items.slice(0, Math.max(0, budget));
        for (const item of shown) lines.push(changeLine(item, context));
        hidden += items.length - shown.length;
        budget -= shown.length;
        if (section.footer) lines.push(section.footer);
    }
    if (hidden) lines.push('', `…e altre ${hidden} novità: le trovi nell'app, in Ultime novità.`);
    for (const item of suspicious) {
        lines.push('', `⚠️ ${item.name}: risultano spariti ${item.count} appuntamenti futuri tutti insieme. Per sicurezza non li ho segnati come cancellati: se è giusto, apri l'app e premi Sincronizza.`);
    }
    if (appUrl) lines.push('', `Apri l'agenda: ${appUrl}`);
    return lines.join('\n');
}

/** Primo messaggio dopo l'attivazione: conferma che il controllo orario funziona. */
export function buildActivationMessage({ pendingCount = 0, appUrl = '' }) {
    const lines = [
        '✅ *Sincronizzazione automatica dell\'agenda attiva*',
        'Ogni ora controllo i calendari dei poliambulatori e dei turni e ti scrivo qui solo quando cambia qualcosa.'
    ];
    if (pendingCount === 1) lines.push('', "❌ 1 appuntamento risulta cancellato dal calendario originale: scegli nell'app se tenerlo o toglierlo (Ultime novità).");
    else if (pendingCount > 1) lines.push('', `❌ ${pendingCount} appuntamenti risultano cancellati dal calendario originale: scegli nell'app se tenerli o toglierli (Ultime novità).`);
    if (appUrl) lines.push('', `Apri l'agenda: ${appUrl}`);
    return lines.join('\n');
}

/**
 * Esegue una sincronizzazione completa.
 * @param {object} deps vedi firestoreSyncDeps
 * @param {{ now?: Date, appUrl?: string, waitForLock?: boolean }} [options]
 * @returns {Promise<{status: 'ok'|'busy', writes?: number, counts?: object, notified?: boolean}>}
 */
export async function runCalendarSync(deps, { now = new Date(), appUrl = '', waitForLock = false } = {}) {
    let locked = await deps.acquireLock();
    for (let attempt = 0; !locked && waitForLock && attempt < LOCK_RETRIES; attempt++) {
        await deps.sleep(LOCK_RETRY_MS);
        locked = await deps.acquireLock();
    }
    if (!locked) return { status: 'busy' };

    try {
        const windowStart = syncWindowStart(now);
        const data = await deps.loadSyncData(windowStart);
        const state = data.syncState || {};
        const feeds = {};
        await Promise.all(data.centers.filter(c => String(c?.icalUrl || '').trim()).map(async center => {
            feeds[center.id] = await deps.fetchCalendar(normalizeGoogleCalendarUrl(String(center.icalUrl).trim())).catch(() => null);
        }));
        const input = { centers: data.centers, events: data.events, patients: data.patients, feeds, now, feeFor: defaultIcalFee, guardMassRemoval: true, windowStart };
        let result = computeCalendarSync(input);
        // Un appuntamento "nuovo" potrebbe essere già in agenda con una data fuori finestra: si rilegge per non perdere i suoi dati.
        const newIds = result.writes.filter(write => write.isNew).map(write => write.id);
        if (newIds.length) {
            const found = await deps.loadEventsByIds(newIds);
            if (found.length) result = computeCalendarSync({ ...input, events: [...data.events, ...found] });
        }
        await deps.applyWrites(result.writes);

        const count = type => result.changes.filter(change => change.type === type).length;
        const counts = { added: count('added'), modified: count('modified'), removed: count('removed'), restored: count('restored'), failed: result.failed.length, suspicious: result.suspicious.length };
        const nowIso = now.toISOString();
        const todayKey = romeDayKey(now);
        const statePatch = {
            lastRunAt: nowIso,
            lastCounts: counts,
            lastFailed: result.failed,
            lastSuspicious: result.suspicious.map(item => item.name),
            recentChanges: appendRecentChanges(state.recentChanges, result.changes, { now }),
            lockUntil: null
        };

        const settings = data.messagingSettings || {};
        const alertsOn = syncAlertsEnabled(settings) && deps.canSend === true;
        let outbox = Array.isArray(state.outbox) ? state.outbox : [];
        let notified = false;
        if (!alertsOn) {
            outbox = [];
        } else {
            const firstRun = !state.initializedAt;
            const fresh = alertableChanges(result.changes, now);
            const suspicious = result.suspicious.filter(item => state.suspiciousNotified?.[item.centerId] !== todayKey);
            const pending = mergeOutbox(outbox, fresh);
            let text = null;
            if (firstRun) {
                const removedIds = new Set(result.changes.filter(c => c.type === 'removed').map(c => c.id));
                const restoredIds = new Set(result.changes.filter(c => c.type === 'restored').map(c => c.id));
                const pendingCount = data.events.filter(ev => ev.extendedProps?.externalRemovalPending === true && !restoredIds.has(ev.id)).length + removedIds.size;
                text = buildActivationMessage({ pendingCount, appUrl });
            } else if (pending.length || suspicious.length) {
                text = buildChangeMessage({ changes: pending, suspicious, patients: data.patients, centers: data.centers, appUrl });
            }
            if (text) {
                try {
                    await deps.send(text);
                    notified = true;
                    outbox = [];
                    statePatch.lastAlertAt = nowIso;
                    statePatch.lastAlertError = null;
                    if (firstRun) statePatch.initializedAt = nowIso;
                    if (suspicious.length) statePatch.suspiciousNotified = { ...(state.suspiciousNotified || {}), ...Object.fromEntries(suspicious.map(item => [item.centerId, todayKey])) };
                } catch (err) {
                    console.error('Sincronizzazione: avviso WhatsApp non inviato', err.message);
                    statePatch.lastAlertError = err.message;
                    statePatch.lastAlertErrorAt = nowIso;
                    if (!firstRun) outbox = pending;
                }
            }
        }
        statePatch.outbox = outbox;
        await deps.saveSyncState(statePatch);
        return { status: 'ok', writes: result.writes.length, counts, notified };
    } catch (err) {
        await deps.releaseLock().catch(() => {});
        throw err;
    }
}

/** Scarica un calendario .ics solo da indirizzi pubblici (stesse protezioni di /api/ical). */
export async function downloadCalendar(url, { fetchUrl = fetchPublicUrl } = {}) {
    const response = await fetchUrl(url, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS));
    if (!response.ok) return null;
    const text = await response.text();
    return isValidCalendarText(text) ? text : null;
}

function isNotFound(err) {
    return err?.code === 5 || /NOT_FOUND|No document to update/i.test(String(err?.message || ''));
}

/** Dipendenze reali: Firestore con le credenziali di servizio, download dei calendari e CallMeBot. */
export function firestoreSyncDeps(env = process.env, { fetchImpl = (...args) => fetch(...args), clock = () => Date.now() } = {}) {
    const root = sharedRoot(env);
    const db = async () => (await firebaseAdmin(env)).db;
    const stateRef = (database) => database.doc(`${root}/settings/calendar_sync`);
    const withId = (snap) => ({ ...snap.data(), id: snap.data().id || snap.id });
    return {
        canSend: Boolean(String(env.CALLMEBOT_PHONE || '').trim() && String(env.CALLMEBOT_APIKEY || '').trim()),
        send: (text) => sendCallMeBot(text, { phone: env.CALLMEBOT_PHONE, apiKey: env.CALLMEBOT_APIKEY, fetchImpl }),
        sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
        fetchCalendar: (url) => downloadCalendar(url),
        async acquireLock() {
            const database = await db();
            const ref = stateRef(database);
            return database.runTransaction(async tx => {
                const snap = await tx.get(ref);
                const until = snap.exists ? snap.data()?.lockUntil : null;
                if (until && new Date(until).getTime() > clock()) return false;
                tx.set(ref, { lockUntil: new Date(clock() + LOCK_TTL_MS).toISOString() }, { merge: true });
                return true;
            });
        },
        async releaseLock() {
            await stateRef(await db()).set({ lockUntil: null }, { merge: true });
        },
        async loadSyncData(windowStart) {
            const database = await db();
            const [centers, events, patients, messaging, state] = await Promise.all([
                database.collection(`${root}/centers_list`).get(),
                database.collection(`${root}/studio_events`).where('start', '>=', windowStart).get(),
                database.collection(`${root}/patients_list`).get(),
                database.doc(`${root}/settings/messaging`).get(),
                stateRef(database).get()
            ]);
            return {
                centers: centers.docs.map(d => d.data()),
                events: events.docs.map(withId),
                patients: patients.docs.map(d => ({ id: d.data().id || d.id, ...d.data() })),
                messagingSettings: messaging.exists ? messaging.data() : null,
                syncState: state.exists ? state.data() : null
            };
        },
        async loadEventsByIds(ids) {
            const database = await db();
            const snaps = await database.getAll(...ids.map(id => database.doc(`${root}/studio_events/${id}`)));
            return snaps.filter(snap => snap.exists).map(withId);
        },
        async applyWrites(writes) {
            const database = await db();
            for (let i = 0; i < writes.length; i += WRITE_CHUNK) {
                await Promise.all(writes.slice(i, i + WRITE_CHUNK).map(async write => {
                    const ref = database.doc(`${root}/studio_events/${write.id}`);
                    if (write.isNew) return ref.set(write.data, { merge: true });
                    try {
                        await ref.update(write.patch);
                    } catch (err) {
                        // Appena eliminato dall'app: niente da aggiornare.
                        if (!isNotFound(err)) throw err;
                    }
                }));
            }
        },
        async saveSyncState(patch) {
            await stateRef(await db()).set({ ...patch, updatedAt: new Date(clock()).toISOString() }, { merge: true });
        }
    };
}
