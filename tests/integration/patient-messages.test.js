import { describe, it, expect, afterEach } from 'vitest';
import { bootApp, SHARED } from '../support/jsdom-app.js';
import { seedDocs, center, patient, studioEvent } from '../fixtures/seed.js';

let app;
let opened;
afterEach(() => app?.close());

function relativeDay(days, hour = 9) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(hour)}:00:00`;
}

const REVIEW_URL = 'https://g.page/r/silvia/review';

async function loggedIn(data = {}) {
    opened = [];
    app = await bootApp({
        docs: seedDocs({
            centers: [center({ id: 'c1', name: 'Poliambulatorio San Benedetto', service: 'Idrocolonterapia' })],
            patients: [
                patient({ id: 'p1', name: 'Mario Rossi', phone: '333 1234567' }),
                patient({ id: 'p2', name: 'Senza Telefono', phone: '' })
            ],
            ...data
        }),
        beforeScript: (w) => { w.open = (...args) => { opened.push(args); return null; }; }
    });
    await app.login();
    app.window.closeSyncReportModal();
    app.window.openPatientsModal();
    return app;
}

const typeButtons = () => app.$$('#message-type-list button').map(b => ({ label: b.querySelector('strong').textContent, disabled: b.disabled, note: b.querySelector('span span').textContent }));
const openedUrl = () => new URL(opened.at(-1)[0]);

describe('messaggi WhatsApp dall’anagrafica pazienti', () => {
    it('mostra il pulsante WhatsApp solo per i pazienti con un numero valido', async () => {
        await loggedIn();
        const cards = Object.fromEntries(app.$$('#patients-alphabetical-list > div').map(c => [c.querySelector('strong').textContent, c]));
        expect(cards['Mario Rossi'].querySelector('button[aria-label="Messaggio WhatsApp a Mario Rossi"]')).not.toBeNull();
        expect(cards['Senza Telefono'].querySelector('button[title="Messaggio WhatsApp"]') === null).toBe(true);
        // il pulsante non è dentro il blocco nascosto su mobile (hidden sm:flex)
        const button = cards['Mario Rossi'].querySelector('button[title="Messaggio WhatsApp"]');
        expect(button.closest('.hidden') === null).toBe(true);
    });

    it('apre il menu con intestazione, trattamento suggerito e tipi di messaggio', async () => {
        await loggedIn({ events: [studioEvent({ id: 'e1', title: 'Seduta', start: relativeDay(-20), end: relativeDay(-20, 10), extendedProps: { patientId: 'p1', centerId: 'c1', centerName: 'Poliambulatorio San Benedetto' } })] });
        app.window.openPatientMessageModal('p1');
        expect(app.isHidden('patient-message-modal')).toBe(false);
        expect(app.text('patient-message-title')).toBe('Messaggio a Mario Rossi');
        expect(app.text('patient-message-subtitle')).toBe('WhatsApp +393331234567');
        expect(app.byId('message-treatment-idrocolonterapia').getAttribute('aria-pressed')).toBe('true');
        expect(app.byId('message-treatment-osteopatia').getAttribute('aria-pressed')).toBe('false');
        expect(app.text('message-treatment-hint')).toMatch(/^Suggerito in base all'appuntamento del \d{2}\/\d{2}\/\d{4}$/);
        expect(typeButtons().map(t => t.label)).toEqual(['Richiesta notizie', 'Nuovo appuntamento', 'Recensione Google', 'Ringraziamento dopo la seduta', 'Promemoria appuntamento']);
        expect(typeButtons().find(t => t.label === 'Promemoria appuntamento')).toMatchObject({ disabled: true, note: 'Nessun appuntamento futuro registrato' });
        expect(typeButtons().find(t => t.label === 'Recensione Google')).toMatchObject({ disabled: true, note: 'Imposta prima il link recensioni (in fondo)' });
    });

    it('mostra l’anteprima modificabile e apre WhatsApp con il testo modificato', async () => {
        await loggedIn();
        app.window.openPatientMessageModal('p1');
        app.window.selectMessageType('news');
        expect(app.isHidden('message-type-list')).toBe(true);
        expect(app.isHidden('message-preview-panel')).toBe(false);
        expect(app.text('message-preview-label')).toBe('Richiesta notizie – Osteopatia');
        const text = app.byId('message-preview-text').value;
        expect(text.startsWith('Gentile Mario Rossi, sono Silvia Chinellato.')).toBe(true);
        expect(text).toContain('trattamento osteopatico');

        app.window.selectMessageTreatment('idrocolonterapia');
        expect(app.byId('message-preview-text').value).toContain('seduta di idrocolonterapia');

        app.setValue('message-preview-text', 'Gentile Mario Rossi, testo personalizzato.');
        await app.window.sendPatientWhatsApp();
        await app.flush();
        expect(opened).toHaveLength(1);
        expect(opened[0][1]).toBe('_blank');
        expect(openedUrl().origin + openedUrl().pathname).toBe('https://wa.me/393331234567');
        expect(openedUrl().searchParams.get('text')).toBe('Gentile Mario Rossi, testo personalizzato.');
        expect(app.isHidden('patient-message-modal')).toBe(true);
        expect(app.toast()).toBe('WhatsApp aperto: contatto registrato.');
    });

    it('registra l’ultimo contatto e lo mostra nella scheda paziente', async () => {
        await loggedIn();
        app.window.openPatientMessageModal('p1');
        app.window.selectMessageType('appointment');
        await app.window.sendPatientWhatsApp();
        await app.flush();
        const saved = app.mock.get(`${SHARED}/patients_list/p1`);
        expect(saved).toMatchObject({ name: 'Mario Rossi', lastContactType: 'appointment', lastContactTreatment: 'osteopatia' });
        expect(saved.contactLog).toHaveLength(1);
        app.window.togglePatientCard('p1');
        expect(app.text('patients-alphabetical-list')).toMatch(/Ultimo contatto WhatsApp.*Nuovo appuntamento \(Osteopatia\)/);
        app.window.openPatientMessageModal('p1');
        expect(app.text('patient-message-subtitle')).toContain('Ultimo contatto:');
    });

    it('conserva al massimo 20 contatti nello storico', async () => {
        const contactLog = Array.from({ length: 20 }, (_, i) => ({ at: `2020-01-${String(20 - i).padStart(2, '0')}T10:00:00.000Z`, type: 'news', treatment: 'osteopatia' }));
        await loggedIn({ patients: [patient({ id: 'p1', name: 'Mario Rossi', phone: '3331234567', contactLog })] });
        app.window.openPatientMessageModal('p1');
        app.window.selectMessageType('news');
        await app.window.sendPatientWhatsApp();
        await app.flush();
        const log = app.mock.get(`${SHARED}/patients_list/p1`).contactLog;
        expect(log).toHaveLength(20);
        expect(log[0].at > log[1].at).toBe(true); // il più recente è in testa
        expect(log.map(e => e.at)).not.toContain('2020-01-01T10:00:00.000Z'); // il più vecchio viene scartato
    });

    it('apre comunque WhatsApp se la registrazione del contatto fallisce', async () => {
        await loggedIn();
        app.window.openPatientMessageModal('p1');
        app.window.selectMessageType('news');
        app.mock.failNext('setDoc', `${SHARED}/patients_list/p1`);
        await app.window.sendPatientWhatsApp();
        await app.flush();
        expect(opened).toHaveLength(1);
        expect(app.toast()).toBe('WhatsApp aperto, ma il contatto non è stato registrato.');
        expect(app.mock.get(`${SHARED}/patients_list/p1`).lastContactAt).toBeUndefined();
    });

    it('non apre WhatsApp con un messaggio vuoto', async () => {
        await loggedIn();
        app.window.openPatientMessageModal('p1');
        app.window.selectMessageType('news');
        app.setValue('message-preview-text', '   ');
        await app.window.sendPatientWhatsApp();
        expect(opened).toHaveLength(0);
        expect(app.toast()).toBe('Il messaggio è vuoto.');
    });

    it('il promemoria usa data, ora e sede del prossimo appuntamento', async () => {
        await loggedIn({ events: [studioEvent({ id: 'next', title: 'Osteopatia', start: relativeDay(3, 15), end: relativeDay(3, 16), extendedProps: { patientId: 'p1', centerId: 'c1', centerName: 'Poliambulatorio San Benedetto' } })] });
        app.window.openPatientMessageModal('p1');
        const reminder = typeButtons().find(t => t.label === 'Promemoria appuntamento');
        expect(reminder.disabled).toBe(false);
        expect(reminder.note).toMatch(/^Appuntamento di \S+ \d+ \S+ alle 15:00$/);
        app.window.selectMessageType('reminder');
        expect(app.byId('message-preview-text').value).toMatch(/l'appuntamento di osteopatia di \S+ \d+ \S+ alle 15:00 presso Poliambulatorio San Benedetto\./);
    });

    it('salva il link recensioni e lo usa nel messaggio', async () => {
        await loggedIn();
        app.window.openPatientMessageModal('p1');
        app.setValue('google-review-url', REVIEW_URL);
        await app.submit('messaging-settings-form');
        expect(app.toast()).toBe('Link recensioni salvato.');
        expect(app.mock.get(`${SHARED}/settings/messaging`)).toMatchObject({ googleReviewUrl: REVIEW_URL });
        expect(typeButtons().find(t => t.label === 'Recensione Google').disabled).toBe(false);
        app.window.selectMessageType('review');
        expect(app.byId('message-preview-text').value).toContain(`Può farlo qui: ${REVIEW_URL}.`);
    });

    it('rifiuta link recensioni non https', async () => {
        await loggedIn();
        app.window.openPatientMessageModal('p1');
        for (const bad of ['javascript:alert(1)', 'http://g.page/r/x']) {
            app.setValue('google-review-url', bad);
            await app.submit('messaging-settings-form');
            expect(app.toast()).toBe('Inserisci un link che inizi con https://');
        }
        expect(app.mock.has(`${SHARED}/settings/messaging`)).toBe(false);
    });

    it('carica il link recensioni salvato e lo sincronizza in tempo reale', async () => {
        await loggedIn({ extra: { [`${SHARED}/settings/messaging`]: { googleReviewUrl: REVIEW_URL } } });
        app.window.openPatientMessageModal('p1');
        expect(app.byId('google-review-url').value).toBe(REVIEW_URL);
        app.mock.seed({ [`${SHARED}/settings/messaging`]: { googleReviewUrl: '' } });
        await app.flush();
        expect(typeButtons().find(t => t.label === 'Recensione Google').disabled).toBe(true);
    });

    it('Indietro torna all’elenco dei messaggi', async () => {
        await loggedIn();
        app.window.openPatientMessageModal('p1');
        app.window.selectMessageType('news');
        app.window.backToMessageTypes();
        expect(app.isHidden('message-type-list')).toBe(false);
        expect(app.isHidden('message-preview-panel')).toBe(true);
    });

    it('il backup include e ripristina le impostazioni dei messaggi', async () => {
        await loggedIn({ extra: { [`${SHARED}/settings/messaging`]: { googleReviewUrl: REVIEW_URL } } });
        const payload = app.fn.buildBackupPayload();
        expect(payload.data.messagingSettings).toEqual({ googleReviewUrl: REVIEW_URL });
        expect(() => app.fn.validateBackupPayload({ ...payload, data: { ...payload.data, messagingSettings: [] } })).toThrow('Sezione messagingSettings non valida.');
        const legacy = { ...payload, data: { ...payload.data } };
        delete legacy.data.messagingSettings;
        expect(app.fn.validateBackupPayload(legacy).data.messagingSettings).toBeNull();
    });

    it('il pulsante WhatsApp dei richiami usa il numero con prefisso internazionale', async () => {
        await loggedIn();
        app.window.openRecallModal();
        const link = app.$('#recall-list a[href^="https://wa.me/"]');
        expect(link.getAttribute('href')).toMatch(/^https:\/\/wa\.me\/393331234567\?text=/);
    });
});
