import { describe, it, expect, afterEach } from 'vitest';
import { bootApp, SHARED, PUBLIC } from '../support/jsdom-app.js';
import { seedDocs, center } from '../fixtures/seed.js';

let app;
afterEach(() => app?.close());

async function loggedIn(data = {}) {
    app = await bootApp({ docs: seedDocs({ centers: [center({ id: 'c1', name: 'Centro Polisalute' })], ...data }) });
    await app.login();
    app.window.closeSyncReportModal();
    return app;
}

describe('gestione poliambulatori', () => {
    it('aggiunge una sede pubblicandola sia nell’area condivisa sia nel sito pubblico', async () => {
        await loggedIn();
        app.window.openCentersModal();
        app.setValue('new-center-name', ' Studio Monza ');
        app.setValue('new-center-service', 'Idrocolonterapia');
        app.setValue('new-center-address', 'Via Italia 1');
        app.setValue('new-center-ical', 'https://example.com/monza.ics');
        app.window.selectCenterColor('#4a8fa8', app.$('#center-color-preset-container button:nth-child(2)'));
        await app.submit('center-form');
        const saved = app.state.centers.find(c => c.name === 'Studio Monza');
        expect(saved).toMatchObject({ service: 'Idrocolonterapia', color: '#4a8fa8', icalUrl: 'https://example.com/monza.ics', showPublic: true, includeInFinance: true, isNonClinicalCalendar: false });
        expect(app.mock.get(`${SHARED}/centers_list/${saved.id}`)).toEqual(saved);
        expect(app.mock.get(`${PUBLIC}/centers_list/${saved.id}`)).toEqual(saved);
        expect(app.toast()).toBe('Poliambulatorio salvato!');
        expect(app.text('centers-management-list')).toContain('Studio Monza');
        expect(app.text('centers-management-list')).toContain('iCal attivo');
        expect(app.text('header-centers-legend')).toContain('Studio Monza');
        expect([...app.byId('studio-center-select').options].map(o => o.textContent)).toContain('Studio Monza');
        expect(app.text('public-centers-grid')).toContain('Studio Monza');
    });

    it('un calendario non clinico disattiva visibilità pubblica e fatturato', async () => {
        await loggedIn();
        app.window.openCentersModal();
        app.byId('new-center-non-clinical').checked = true;
        app.window.applyNonClinicalCenterFormState();
        expect(app.byId('new-center-public').checked).toBe(false);
        expect(app.byId('new-center-public').disabled).toBe(true);
        expect(app.byId('new-center-finance').disabled).toBe(true);
        app.setValue('new-center-name', 'Agenda personale');
        app.setValue('new-center-service', 'Privato');
        await app.submit('center-form');
        const saved = app.state.centers.find(c => c.name === 'Agenda personale');
        expect(saved).toMatchObject({ showPublic: false, includeInFinance: false, isNonClinicalCalendar: true });
        expect(app.text('header-centers-legend')).not.toContain('Agenda personale');
        expect(app.text('centers-management-list')).toContain('Non Clinico');
    });

    it('modifica una sede esistente precompilando il modulo', async () => {
        await loggedIn();
        app.window.editCenter('c1');
        expect(app.byId('new-center-name').value).toBe('Centro Polisalute');
        expect(app.text('center-form-title')).toBe('Modifica Poliambulatorio');
        expect(app.isHidden('center-cancel-edit')).toBe(false);
        app.setValue('new-center-phone', '02 999');
        await app.submit('center-form');
        expect(app.mock.get(`${SHARED}/centers_list/c1`).phone).toBe('02 999');
        expect(app.text('center-form-title')).toBe('Aggiungi Nuovo Poliambulatorio');
        expect(app.byId('center-edit-id').value).toBe('');
    });

    it('elimina una sede dopo conferma', async () => {
        await loggedIn();
        app.window.confirmDeleteCenter('c1');
        await app.confirm();
        expect(app.mock.has(`${SHARED}/centers_list/c1`)).toBe(false);
        expect(app.mock.has(`${PUBLIC}/centers_list/c1`)).toBe(false);
        expect(app.state.centers).toHaveLength(0);
        expect(app.toast()).toBe('Poliambulatorio eliminato.');
    });

    // Regressione (difetto corretto): gli errori di scrittura su Firestore vengono ignorati e compare comunque
    // il messaggio di successo (vale anche per trattamenti, news e guide).
    it('segnala un errore se la sede non viene salvata', async () => {
        await loggedIn();
        app.setValue('new-center-name', 'X');
        app.setValue('new-center-service', 'Y');
        app.mock.failNext('setDoc', PUBLIC);
        await app.submit('center-form');
        expect(app.toast()).toBe('Errore: poliambulatorio non salvato. Controlla i permessi Firestore.');
        expect(app.state.centers.map(c => c.name)).toEqual(['Centro Polisalute']);
        expect(app.byId('new-center-name').value).toBe('X'); // il modulo conserva i dati per riprovare
    });

    it('non rimuove la sede dall’elenco se l’eliminazione fallisce', async () => {
        await loggedIn();
        app.mock.failNext('deleteDoc', PUBLIC);
        app.window.confirmDeleteCenter('c1');
        await app.confirm();
        expect(app.toast()).toBe('Errore: operazione non completata.');
        expect(app.state.centers).toHaveLength(1);
        expect(app.isHidden('confirm-modal')).toBe(false);
    });

    it.each([
        ['treatment-form', { 'new-treatment-title': 'T', 'new-treatment-desc': 'D' }, 'treatments_list', 'Errore: trattamento non salvato. Controlla i permessi Firestore.', 'treatments'],
        ['news-form', { 'new-news-title': 'N', 'new-news-content': 'C' }, 'news_list', 'Errore: news non pubblicata. Controlla i permessi Firestore.', 'news'],
        ['prep-form', { 'prep-title': 'P', 'prep-tag': 'T', 'prep-content': 'C' }, 'preparations_list', 'Errore: guida non salvata. Controlla i permessi Firestore.', 'preparations']
    ])('%s: segnala l’errore e non aggiunge il contenuto se il salvataggio fallisce', async (form, values, collection, message, stateKey) => {
        await loggedIn();
        const before = app.state[stateKey].length;
        for (const [id, value] of Object.entries(values)) app.setValue(id, value);
        app.mock.failNext('setDoc', `${PUBLIC}/${collection}`);
        await app.submit(form);
        expect(app.toast()).toBe(message);
        expect(app.state[stateKey]).toHaveLength(before);
    });
});

describe('gestione trattamenti', () => {
    it('aggiunge, modifica ed elimina un trattamento aggiornando il sito pubblico', async () => {
        await loggedIn();
        app.window.openTreatmentsAdminModal();
        app.setValue('new-treatment-title', 'Linfodrenaggio');
        app.setValue('new-treatment-desc', 'Drenaggio manuale');
        await app.submit('treatment-form');
        const t = app.state.treatments.find(x => x.title === 'Linfodrenaggio');
        expect(app.mock.get(`${PUBLIC}/treatments_list/${t.id}`)).toMatchObject({ title: 'Linfodrenaggio', desc: 'Drenaggio manuale' });
        expect(app.text('public-treatments-grid')).toContain('Linfodrenaggio');
        expect(app.toast()).toBe('Trattamento salvato con successo!');

        app.window.editTreatment(t.id);
        expect(app.text('treatment-submit-btn-text')).toBe('Aggiorna Trattamento');
        app.setValue('new-treatment-desc', 'Nuova descrizione');
        await app.submit('treatment-form');
        expect(app.mock.get(`${PUBLIC}/treatments_list/${t.id}`).desc).toBe('Nuova descrizione');
        expect(app.state.treatments.filter(x => x.id === t.id)).toHaveLength(1);

        app.window.confirmDeleteTreatment(t.id);
        await app.confirm();
        expect(app.mock.has(`${PUBLIC}/treatments_list/${t.id}`)).toBe(false);
        expect(app.text('public-treatments-grid')).not.toContain('Linfodrenaggio');
    });
});

describe('gestione news', () => {
    it('pubblica, modifica ed elimina una news', async () => {
        await loggedIn();
        app.window.openNewsAdminModal();
        expect(app.byId('new-news-date').value).toBe(new Date().toISOString().split('T')[0]);
        app.setValue('new-news-title', 'Nuovi orari');
        app.setValue('new-news-date', '2030-09-01');
        app.setValue('new-news-content', 'Da settembre riceviamo anche il sabato.');
        app.setValue('new-news-link', 'https://example.com/orari');
        await app.submit('news-form');
        const n = app.state.news.find(x => x.title === 'Nuovi orari');
        expect(app.mock.get(`${PUBLIC}/news_list/${n.id}`)).toMatchObject({ date: '2030-09-01', link: 'https://example.com/orari' });
        expect(app.toast()).toBe('News pubblicata!');
        expect(app.text('public-news-grid')).toContain('1 settembre 2030');

        app.window.editNews(n.id);
        expect(app.text('news-submit-btn-text')).toBe('Aggiorna News');
        app.setValue('new-news-title', 'Orari aggiornati');
        await app.submit('news-form');
        expect(app.mock.get(`${PUBLIC}/news_list/${n.id}`).title).toBe('Orari aggiornati');

        app.window.confirmDeleteNews(n.id);
        await app.confirm();
        expect(app.mock.has(`${PUBLIC}/news_list/${n.id}`)).toBe(false);
    });

    it('mostra il messaggio vuoto dopo aver eliminato tutte le news', async () => {
        await loggedIn({ news: [{ id: 'solo', title: 'Unica', content: 'x', date: '' }] });
        app.window.confirmDeleteNews('solo');
        await app.confirm();
        expect(app.text('public-news-grid')).toBe('Nessuna news pubblicata al momento.');
    });
});

describe('gestione guide di preparazione', () => {
    it('aggiunge ed elimina una guida', async () => {
        await loggedIn();
        app.window.openPrepAdminModal();
        app.setValue('prep-title', 'Prima dell’osteopatia');
        app.setValue('prep-tag', 'Osteopatia');
        app.setValue('prep-content', 'Portare esami recenti');
        await app.submit('prep-form');
        const p = app.state.preparations.find(x => x.tag === 'Osteopatia');
        expect(app.mock.get(`${PUBLIC}/preparations_list/${p.id}`)).toMatchObject({ content: 'Portare esami recenti' });
        expect(app.text('public-preparations-grid')).toContain('Portare esami recenti');
        expect(app.toast()).toBe('Guida salvata!');
        app.window.confirmDeletePrep(p.id);
        await app.confirm();
        expect(app.mock.has(`${PUBLIC}/preparations_list/${p.id}`)).toBe(false);
        expect(app.toast()).toBe('Guida eliminata.');
    });
});
