import { describe, it, expect, afterEach } from 'vitest';
import { bootApp, SHARED } from '../support/jsdom-app.js';
import { seedDocs, center, patient, studioEvent } from '../fixtures/seed.js';

let app;
let opened;
afterEach(() => app?.close());

// "Adesso" per l'app: lunedì 4 marzo 2030, ore 12:00 (il tempo scorre normalmente da lì).
const NOW = new Date(2030, 2, 4, 12, 0).getTime();
function fixClock(w) {
    const offset = NOW - Date.now();
    const RealDate = w.Date;
    class ShiftedDate extends RealDate {
        constructor(...args) { if (args.length === 0) super(RealDate.now() + offset); else super(...args); }
        static now() { return RealDate.now() + offset; }
    }
    w.Date = ShiftedDate;
}

const events = [
    studioEvent({ id: 'e1', title: 'Idrocolonterapia', start: '2030-03-05T09:00:00', end: '2030-03-05T10:00:00', extendedProps: { centerId: 'cms', centerName: 'CMS - Carate Brianza', patientId: 'p1' } }),
    studioEvent({ id: 'e2', title: 'Trattamento osteopatico', start: '2030-03-05T15:30:00', end: '2030-03-05T16:30:00', extendedProps: { patientId: 'p2' } }),
    studioEvent({ id: 'e3', title: 'Nuovo contatto', start: '2030-03-05T17:00:00', end: '2030-03-05T18:00:00' }),
    studioEvent({ id: 'passato', title: 'Stamattina', start: '2030-03-04T09:00:00', end: '2030-03-04T10:00:00', extendedProps: { patientId: 'p1' } }),
    studioEvent({ id: 'oggi', title: 'Osteopatia', start: '2030-03-04T16:00:00', end: '2030-03-04T17:00:00', extendedProps: { patientId: 'p1' } })
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
        beforeScript: (w) => { fixClock(w); w.open = (...args) => { opened.push(args); return null; }; }
    });
    await app.login();
    app.window.closeSyncReportModal();
    app.window.openRemindersModal();
    return app;
}

const rows = (section) => app.$$(`#reminders-list [data-reminder-section="${section}"] [data-reminder-id]`);
const ids = (section) => rows(section).map(r => r.dataset.reminderId);

describe('promemoria di oggi e domani', () => {
    it('elenca gli appuntamenti ancora da fare oggi e quelli di domani', async () => {
        await loggedIn();
        expect(app.isHidden('reminders-modal')).toBe(false);
        expect(ids('today')).toEqual(['oggi']); // quello di stamattina è già passato
        expect(ids('tomorrow')).toEqual(['e1', 'e2', 'e3']);
        expect(app.text('reminders-summary')).toBe('4 appuntamenti • 2 promemoria da inviare');
        const headings = app.$$('#reminders-list h4').map(h => h.textContent.replace(/\s+/g, ' ').trim());
        expect(headings).toEqual(['Oggi – lunedì 4 marzo', 'Domani – martedì 5 marzo']);
    });

    it('evidenzia chi non ha telefono o paziente', async () => {
        await loggedIn();
        const texts = rows('tomorrow').map(r => r.textContent.replace(/\s+/g, ' ').trim());
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
        expect(app.byId('message-preview-text').value).toBe('Gentile Mario Rossi, le ricordo la seduta di idrocolonterapia di martedì 5 marzo alle 09:00 presso CMS - Carate Brianza. Nei due giorni precedenti le consiglio un\'alimentazione leggera, ricca di acqua e povera di scorie. In caso di imprevisti la prego di avvisarmi per tempo. Cordiali saluti, Silvia Chinellato');
        await app.window.sendPatientWhatsApp();
        await app.flush();
        expect(new URL(opened.at(-1)[0]).pathname).toBe('/393331234567');
        expect(app.toast()).toBe('WhatsApp aperto: promemoria registrato.');
        const saved = app.mock.get(`${SHARED}/studio_events/e1`);
        expect(saved.extendedProps.reminderSentAt).toMatch(/^2030-03-04T/);
        expect(saved.extendedProps).toMatchObject({ patientId: 'p1', centerId: 'cms' });
        expect(app.mock.get(`${SHARED}/patients_list/p1`)).toMatchObject({ lastContactType: 'reminder', lastContactTreatment: 'idrocolonterapia' });
        const first = rows('tomorrow')[0].textContent;
        expect(first).toMatch(/✓ inviato alle \d{2}:\d{2}/);
        expect(first).toContain('Invia di nuovo');
        expect(app.text('reminders-summary')).toBe('4 appuntamenti • 1 promemoria da inviare');
    });

    it('il promemoria di oggi usa data, ora e trattamento di quell\'appuntamento', async () => {
        await loggedIn();
        app.window.sendTomorrowReminder('oggi');
        expect(app.byId('message-treatment-osteopatia').getAttribute('aria-pressed')).toBe('true');
        expect(app.byId('message-preview-text').value).toContain("l'appuntamento di osteopatia di lunedì 4 marzo alle 16:00 presso lo studio");
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

    it('messaggi chiari se non ci sono appuntamenti', async () => {
        await loggedIn({ events: [events[3]] });
        expect(app.text('reminders-summary')).toBe('Nessun appuntamento da ricordare');
        expect(app.text('reminders-list')).toContain('Nessun altro appuntamento con pazienti oggi.');
        expect(app.text('reminders-list')).toContain('Nessun appuntamento con pazienti domani.');
    });
});
