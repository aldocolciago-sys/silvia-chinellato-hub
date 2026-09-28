import { describe, it, expect, afterEach } from 'vitest';
import { bootApp, SHARED } from '../support/jsdom-app.js';
import { seedDocs, patient, APP_ID } from '../fixtures/seed.js';

let app;
let opened;
afterEach(() => app?.close());

const REQUESTS = `artifacts/${APP_ID}/requests`;
const request = (id, extra = {}) => ({ _id: id, name: 'Anna Bianchi', phone: '333 7654321', email: 'anna@example.com', treatment: 'osteopatia', preferredDays: 'martedì', preferredTime: 'pomeriggio', message: 'Mal di schiena', consent: true, createdAt: '2030-03-04T10:00:00.000Z', status: 'new', ...extra });

async function publicSite() {
    app = await bootApp({ docs: seedDocs({}) });
    return app;
}
function fillRequest({ name = 'Anna Bianchi', phone = '333 7654321', email = '', days = '', time = '', message = '', consent = true, startedAgo = 10000 } = {}) {
    app.setValue('request-name', name);
    app.setValue('request-phone', phone);
    app.setValue('request-email', email);
    app.setValue('request-days', days);
    app.setValue('request-time', time);
    app.setValue('request-message', message);
    app.byId('request-consent').checked = consent;
    if (startedAgo !== null) app.byId('appointment-request-form').dataset.startedAt = String(Date.now() - startedAgo);
}

describe('modulo pubblico di richiesta appuntamento', () => {
    it('invia una richiesta valida con i soli campi compilati', async () => {
        await publicSite();
        fillRequest({ email: 'anna@example.com', days: 'martedì o giovedì', time: 'pomeriggio', message: 'Mal di schiena' });
        await app.submit('appointment-request-form');
        const saved = app.mock.list(REQUESTS);
        expect(saved).toHaveLength(1);
        expect(saved[0]).toMatchObject({ name: 'Anna Bianchi', phone: '333 7654321', email: 'anna@example.com', preferredDays: 'martedì o giovedì', preferredTime: 'pomeriggio', message: 'Mal di schiena', treatment: 'osteopatia', consent: true, status: 'new' });
        expect(Object.keys(app.mock.get(`${REQUESTS}/${saved[0].id}`)).sort()).toEqual(['consent', 'createdAt', 'email', 'message', 'name', 'phone', 'preferredDays', 'preferredTime', 'status', 'treatment']);
        expect(app.text('request-feedback')).toBe('Grazie! La richiesta è stata inviata: Silvia la ricontatterà al più presto.');
        expect(app.byId('request-name').value).toBe('');
    });

    it('non salva campi vuoti facoltativi', async () => {
        await publicSite();
        fillRequest();
        await app.submit('appointment-request-form');
        const [only] = app.mock.list(REQUESTS);
        expect(Object.keys(app.mock.get(`${REQUESTS}/${only.id}`)).sort()).toEqual(['consent', 'createdAt', 'name', 'phone', 'status', 'treatment']);
    });

    it('mostra gli errori senza inviare', async () => {
        await publicSite();
        fillRequest({ phone: '12', consent: false });
        await app.submit('appointment-request-form');
        expect(app.text('request-feedback')).toBe('Indichi un numero di telefono valido. Per inviare la richiesta serve il consenso al trattamento dei dati.');
        expect(app.mock.list(REQUESTS)).toHaveLength(0);
    });

    it('antispam: campo nascosto o compilazione troppo veloce → nessun salvataggio, stesso messaggio', async () => {
        await publicSite();
        fillRequest();
        app.setValue('request-website', 'http://spam.example');
        await app.submit('appointment-request-form');
        expect(app.text('request-feedback')).toMatch(/^Grazie!/);
        app.setValue('request-website', '');
        fillRequest({ startedAgo: 500 });
        await app.submit('appointment-request-form');
        expect(app.mock.list(REQUESTS)).toHaveLength(0);
    });

    it('un secondo invio immediato dallo stesso browser viene bloccato', async () => {
        await publicSite();
        fillRequest();
        await app.submit('appointment-request-form');
        fillRequest({ name: 'Anna di nuovo' });
        await app.submit('appointment-request-form');
        expect(app.text('request-feedback')).toBe("Richiesta già inviata: attenda un minuto prima di inviarne un'altra.");
        expect(app.mock.list(REQUESTS)).toHaveLength(1);
    });

    it('segnala un errore di invio', async () => {
        await publicSite();
        fillRequest();
        app.mock.failNext('setDoc');
        await app.submit('appointment-request-form');
        expect(app.text('request-feedback')).toBe('Invio non riuscito. La preghiamo di riprovare o di scrivere a silviachine@gmail.com.');
    });
});

describe('richieste nell\'area riservata', () => {
    async function loggedIn({ requests = [request('r1'), request('r2', { name: 'Luca Verdi', phone: '333 1234567', createdAt: '2030-03-05T09:00:00.000Z', message: '' }), request('r3', { status: 'archived', name: 'Vecchia Richiesta' })], patients = [] } = {}) {
        opened = [];
        const docs = seedDocs({ patients, extra: Object.fromEntries(requests.map(({ _id, ...r }) => [`${REQUESTS}/${_id}`, r])) });
        app = await bootApp({ docs, beforeScript: (w) => { w.open = (...args) => { opened.push(args); return null; }; } });
        await app.login();
        app.window.closeSyncReportModal();
        return app;
    }
    const cards = () => app.$$('#requests-list [data-request-id]');

    it('contatore delle nuove richieste ed elenco dalla più recente', async () => {
        await loggedIn();
        expect(app.text('requests-badge')).toBe('2');
        expect(app.isHidden('requests-badge')).toBe(false);
        app.window.openRequestsModal();
        expect(app.text('requests-summary')).toBe('2 richieste da gestire');
        expect(cards().map(c => c.dataset.requestId)).toEqual(['r2', 'r1']);
        expect(cards()[1].textContent).toContain('Mal di schiena');
        app.byId('requests-show-archived').checked = true;
        app.window.renderRequestsList();
        expect(cards().map(c => c.dataset.requestId)).toEqual(['r2', 'r1', 'r3']);
    });

    it('archivia ed elimina', async () => {
        await loggedIn();
        app.window.openRequestsModal();
        await app.window.archiveRequest('r1');
        expect(app.mock.get(`${REQUESTS}/r1`)).toMatchObject({ status: 'archived' });
        expect(app.text('requests-badge')).toBe('1');
        expect(cards().map(c => c.dataset.requestId)).toEqual(['r2']);
        app.window.confirmDeleteRequest('r2');
        await app.confirm();
        expect(app.mock.get(`${REQUESTS}/r2`)).toBeUndefined();
        expect(app.isHidden('requests-badge')).toBe(true);
        expect(app.text('requests-list')).toBe('Nessuna nuova richiesta dal sito.');
    });

    it('risponde su WhatsApp con un messaggio precompilato', async () => {
        await loggedIn();
        app.window.openRequestsModal();
        app.window.replyToRequest('r1');
        await app.flush();
        const url = new URL(opened.at(-1)[0]);
        expect(url.pathname).toBe('/393337654321');
        expect(url.searchParams.get('text')).toMatch(/^Gentile Anna Bianchi, sono Silvia Chinellato/);
        expect(app.mock.get(`${REQUESTS}/r1`).repliedAt).toBeTruthy();
    });

    it('crea paziente e appuntamento dai dati della richiesta', async () => {
        await loggedIn();
        app.window.openRequestsModal();
        app.window.convertRequest('r1');
        expect(app.isHidden('requests-modal')).toBe(true);
        expect(app.isHidden('studio-modal')).toBe(false);
        expect(app.isHidden('patient-edit-modal')).toBe(false);
        expect(app.byId('patient-name').value).toBe('Anna Bianchi');
        expect(app.byId('patient-phone').value).toBe('333 7654321');
        expect(app.byId('patient-email').value).toBe('anna@example.com');
        expect(app.byId('patient-current-issues').value).toBe('Mal di schiena\nGiorni preferiti: martedì\nFascia preferita: pomeriggio');
        await app.submit('patient-form');
        const created = app.state.patients.find(p => p.name === 'Anna Bianchi');
        expect(app.byId('studio-patient-select').value).toBe(created.id);
        expect(app.byId('studio-treatment').value).toBe('osteopatia');
        app.setValue('studio-date', '2030-03-12');
        app.setValue('studio-time-start', '15:00');
        app.window.onStartTimeChange();
        await app.submit('studio-event-form');
        const ev = app.mock.list(`${SHARED}/studio_events`)[0];
        expect(ev.extendedProps).toMatchObject({ patientId: created.id, treatment: 'osteopatia' });
        expect(app.mock.get(`${REQUESTS}/r1`)).toMatchObject({ status: 'converted', eventId: ev.id, patientId: created.id });
        expect(app.text('requests-badge')).toBe('1');
    });

    it('se il paziente esiste già (stesso telefono) lo seleziona senza crearne uno nuovo', async () => {
        await loggedIn({ patients: [patient({ id: 'p9', name: 'Luca Verdi', phone: '+39 333 1234567' })] });
        app.window.openRequestsModal();
        expect(cards()[0].textContent).toContain('già in anagrafica: Luca Verdi');
        app.window.convertRequest('r2');
        expect(app.isHidden('patient-edit-modal')).toBe(true);
        expect(app.byId('studio-patient-select').value).toBe('p9');
        expect(app.byId('studio-title').value).toBe('Osteopatia - Luca Verdi');
    });

    it('chiudendo il modulo senza salvare la richiesta resta da gestire', async () => {
        await loggedIn();
        app.window.convertRequest('r2');
        app.window.closePatientEditModal();
        app.window.closeStudioModal();
        app.window.openStudioModal();
        app.setValue('studio-title', 'Altro');
        app.setValue('studio-date', '2030-03-12');
        await app.submit('studio-event-form');
        expect(app.mock.get(`${REQUESTS}/r2`).status).toBe('new');
    });

    it('il backup include le richieste', async () => {
        await loggedIn();
        expect(app.fn.buildBackupPayload().data.requests.map(r => r.id).sort()).toEqual(['r1', 'r2', 'r3']);
    });
});
