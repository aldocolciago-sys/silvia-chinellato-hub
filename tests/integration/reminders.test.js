import { describe, it, expect, afterEach } from 'vitest';
import { bootApp, SHARED } from '../support/jsdom-app.js';
import { seedDocs, center, patient, studioEvent } from '../fixtures/seed.js';

let app;
let opened;
afterEach(() => app?.close());

function relativeDay(days, hour = 9, minute = 0) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(hour)}:${pad(minute)}:00`;
}

const events = [
    studioEvent({ id: 'e1', title: 'Idrocolonterapia', start: relativeDay(1, 9), end: relativeDay(1, 10), extendedProps: { centerId: 'cms', centerName: 'CMS - Carate Brianza', patientId: 'p1' } }),
    studioEvent({ id: 'e2', title: 'Trattamento osteopatico', start: relativeDay(1, 15, 30), end: relativeDay(1, 16, 30), extendedProps: { patientId: 'p2' } }),
    studioEvent({ id: 'e3', title: 'Nuovo contatto', start: relativeDay(1, 17), end: relativeDay(1, 18) }),
    studioEvent({ id: 'e4', title: 'Oggi', start: relativeDay(0, 9), end: relativeDay(0, 10), extendedProps: { patientId: 'p1' } })
];

async function loggedIn(data = {}) {
    opened = [];
    app = await bootApp({
        docs: seedDocs({
            centers: [center({ id: 'cms', name: 'CMS - Carate Brianza', service: 'Idrocolonterapia' })],
            patients: [patient({ id: 'p1', name: 'Mario Rossi', phone: '333 1234567' }), patient({ id: 'p2', name: 'Anna Bianchi', phone: '' })],
            events,
            ...data
        }),
        beforeScript: (w) => { w.open = (...args) => { opened.push(args); return null; }; }
    });
    await app.login();
    app.window.closeSyncReportModal();
    app.window.openRemindersModal();
    return app;
}

const rows = () => app.$$('#reminders-list [data-reminder-id]');

describe('promemoria di domani', () => {
    it('elenca gli appuntamenti di domani ed evidenzia chi non ha telefono o paziente', async () => {
        await loggedIn();
        expect(app.isHidden('reminders-modal')).toBe(false);
        expect(rows().map(r => r.dataset.reminderId)).toEqual(['e1', 'e2', 'e3']);
        expect(app.text('reminders-summary')).toBe('3 appuntamenti • 1 promemoria da inviare');
        const texts = rows().map(r => r.textContent.replace(/\s+/g, ' ').trim());
        expect(texts[0]).toContain('09:00');
        expect(texts[0]).toContain('Mario Rossi');
        expect(texts[0]).toContain('CMS - Carate Brianza');
        expect(texts[1]).toContain('Telefono mancante');
        expect(texts[2]).toContain('Nessun paziente associato');
    });

    it('apre il messaggio di promemoria già compilato e registra l\'invio', async () => {
        await loggedIn();
        app.window.sendTomorrowReminder('e1');
        expect(app.isHidden('patient-message-modal')).toBe(false);
        expect(app.isHidden('message-preview-panel')).toBe(false);
        expect(app.byId('message-treatment-idrocolonterapia').getAttribute('aria-pressed')).toBe('true');
        const text = app.byId('message-preview-text').value;
        expect(text).toMatch(/^Gentile Mario Rossi, le ricordo la seduta di idrocolonterapia di /);
        expect(text).toContain('alle 09:00 presso CMS - Carate Brianza');
        await app.window.sendPatientWhatsApp();
        await app.flush();
        const url = new URL(opened.at(-1)[0]);
        expect(url.pathname).toBe('/393331234567');
        expect(app.toast()).toBe('WhatsApp aperto: promemoria registrato.');
        const saved = app.mock.get(`${SHARED}/studio_events/e1`);
        expect(saved.extendedProps.reminderSentAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(saved.extendedProps).toMatchObject({ patientId: 'p1', centerId: 'cms' });
        expect(app.mock.get(`${SHARED}/patients_list/p1`)).toMatchObject({ lastContactType: 'reminder', lastContactTreatment: 'idrocolonterapia' });
        const first = rows()[0].textContent;
        expect(first).toMatch(/✓ inviato alle \d{2}:\d{2}/);
        expect(first).toContain('Invia di nuovo');
        expect(app.text('reminders-summary')).toBe('3 appuntamenti • 0 promemoria da inviare');
    });

    it('usa il promemoria dell\'appuntamento scelto anche se ce n\'è uno prima', async () => {
        await loggedIn({ events: [...events, studioEvent({ id: 'e0', title: 'Osteopatia', start: relativeDay(0, 23), end: relativeDay(0, 23, 30), extendedProps: { patientId: 'p1' } })] });
        app.window.sendTomorrowReminder('e1');
        expect(app.byId('message-preview-text').value).toContain('alle 09:00');
    });

    it('tornando alla scelta dei messaggi il promemoria non resta legato all\'appuntamento', async () => {
        await loggedIn();
        app.window.sendTomorrowReminder('e1');
        app.window.backToMessageTypes();
        app.window.selectMessageType('news');
        await app.window.sendPatientWhatsApp();
        await app.flush();
        expect(app.mock.get(`${SHARED}/studio_events/e1`).extendedProps.reminderSentAt).toBeUndefined();
    });

    it('i pulsanti portano alla scheda paziente o all\'appuntamento da completare', async () => {
        await loggedIn();
        app.window.openReminderPatient('p2');
        expect(app.isHidden('reminders-modal')).toBe(true);
        expect(app.isHidden('patient-edit-modal')).toBe(false);
        expect(app.byId('patient-name').value).toBe('Anna Bianchi');
        app.window.openReminderEvent('e3');
        expect(app.isHidden('studio-modal')).toBe(false);
        expect(app.byId('studio-edit-event-id').value).toBe('e3');
    });

    it('messaggio chiaro se domani non ci sono appuntamenti', async () => {
        await loggedIn({ events: [events[3]] });
        expect(app.text('reminders-list')).toBe('Nessun appuntamento con pazienti per domani.');
    });
});
