import { describe, it, expect, afterEach } from 'vitest';
import { bootApp, FakeCalendar } from '../support/jsdom-app.js';
import { seedDocs, center, SHARED, PUBLIC } from '../fixtures/seed.js';

let app;
afterEach(() => app?.close());

describe('sito pubblico', () => {
    it('mostra i contenuti predefiniti se Firestore è vuoto', async () => {
        app = await bootApp();
        expect(app.$$('#public-treatments-grid > div').map(d => d.querySelector('h4').textContent))
            .toEqual(['Idrocolonterapia', 'Osteopatia', 'Primo colloquio']);
        expect(app.$$('#public-centers-grid > div').length).toBe(2);
        expect(app.$$('#public-news-grid > div').length).toBe(1);
        expect(app.$$('#public-preparations-grid > div').length).toBe(1);
    });

    it('all’accesso sostituisce una sola volta i vecchi testi predefiniti dei trattamenti, senza toccare quelli scritti da Silvia', async () => {
        const docs = seedDocs({ treatments: [
            { id: 't1', title: 'Idrocolonterapia', icon: 'fa-droplet', desc: "Depurazione profonda e delicata del colon, utile per eliminare tossine, ridurre l'infiammazione e ripristinare la vitalità dell'organismo." },
            { id: 't3', title: 'Prevenzione & Equilibrio', icon: 'fa-heart-pulse', desc: 'Consulenze e percorsi personalizzati volti al mantenimento dello stato di salute e alla prevenzione dei disturbi cronici.' },
            { id: 't2', title: 'Osteopatia', icon: 'fa-hands', desc: 'Testo scritto da Silvia' }
        ] });
        delete docs[`${SHARED}/_meta/treatment-texts-v2`];
        app = await bootApp({ docs });
        await app.login();
        expect(app.mock.get(`${PUBLIC}/treatments_list/t1`)).toMatchObject({ title: 'Idrocolonterapia', desc: expect.stringMatching(/^Lavaggio del colon/) });
        expect(app.mock.get(`${PUBLIC}/treatments_list/t3`)).toMatchObject({ title: 'Primo colloquio', icon: 'fa-heart-pulse' });
        expect(app.mock.get(`${PUBLIC}/treatments_list/t2`).desc).toBe('Testo scritto da Silvia');
        expect(app.mock.get(`${SHARED}/_meta/treatment-texts-v2`)).toMatchObject({ completed: true, updated: ['Idrocolonterapia', 'Primo colloquio'] });
        expect(app.text('public-treatments-grid')).not.toContain('tossine');
    });

    it('carica sedi, trattamenti, news e guide pubblicate su Firestore', async () => {
        app = await bootApp({
            docs: seedDocs({
                publicCenters: [center({ id: 'c9', name: 'Studio Monza', service: 'Idrocolon', address: 'Via Monza 1', phone: '039 000', siteUrl: 'https://monza.example', bookingUrl: '' })],
                treatments: [{ id: 't9', title: 'Massaggio viscerale', icon: 'fa-spa', desc: 'Descrizione' }],
                news: [{ id: 'n9', title: 'Nuova sede', date: '2030-03-01', content: 'Apertura della nuova sede', link: 'https://example.com/news' }],
                preparations: [{ id: 'p9', title: 'Prima della seduta', tag: 'Osteopatia', content: 'Indossare abiti comodi' }]
            })
        });
        const centerCard = app.$('#public-centers-grid > div');
        expect(centerCard.textContent).toContain('Studio Monza');
        expect(centerCard.textContent).toContain('Via Monza 1');
        expect(centerCard.textContent).toContain('039 000');
        expect(centerCard.querySelector('a[href="https://monza.example"]').textContent).toContain('Sito Web');
        expect(centerCard.querySelector('a[href="https://monza.example"]').className).toContain('bg-water-50');
        expect(centerCard.textContent).not.toContain('Prenota Online');
        expect(app.text('public-treatments-grid')).toContain('Massaggio viscerale');
        expect(app.text('public-news-grid')).toContain('1 marzo 2030');
        expect(app.$('#public-news-grid a[href="https://example.com/news"]')).not.toBeNull();
        expect(app.$('#public-news-grid a[href="https://example.com/news"]').className).toContain('bg-water-50');
        expect(app.text('public-preparations-grid')).toContain('Indossare abiti comodi');
    });

    it('nasconde le sedi non pubbliche e i calendari non clinici', async () => {
        app = await bootApp({
            docs: seedDocs({
                publicCenters: [
                    center({ id: 'a', name: 'Visibile' }),
                    center({ id: 'b', name: 'Nascosta', showPublic: false }),
                    center({ id: 'c', name: 'Personale', isNonClinicalCalendar: true })
                ]
            })
        });
        const names = app.$$('#public-centers-grid h4').map(h => h.textContent);
        expect(names).toEqual(['Visibile']);
    });

    it('mostra un messaggio quando non ci sono sedi visibili', async () => {
        app = await bootApp({ docs: seedDocs({ publicCenters: [center({ showPublic: false })] }) });
        expect(app.text('public-centers-grid')).toBe('Nessun poliambulatorio registrato.');
    });

    it('espande e riduce il testo di una news', async () => {
        app = await bootApp();
        const content = app.byId('news-content-0');
        expect(content.querySelector('p').classList.contains('line-clamp-2')).toBe(true);
        app.window.toggleNewsExpand(0);
        expect(content.classList.contains('expanded')).toBe(true);
        expect(content.querySelector('p').classList.contains('line-clamp-2')).toBe(false);
        expect(app.text('news-btn-0')).toBe('Riduci');
        app.window.toggleNewsExpand(0);
        expect(content.classList.contains('expanded')).toBe(false);
        expect(app.text('news-btn-0')).toBe('Leggi tutto');
    });

    it('ignora toggleNewsExpand per un indice inesistente', async () => {
        app = await bootApp();
        expect(() => app.window.toggleNewsExpand(99)).not.toThrow();
    });

    it('continua a mostrare i contenuti predefiniti se la lettura pubblica fallisce', async () => {
        app = await bootApp({ beforeScript: () => {} });
        app.mock.failNext('getDocs', 'artifacts/silvia-chinellato-app/public', { persistent: true });
        app.fn.loadPublicDataFromFirestore();
        await app.flush();
        expect(app.$$('#public-treatments-grid > div').length).toBe(3);
    });

    it('contiene i link di contatto (email e Instagram)', async () => {
        app = await bootApp();
        expect(app.$('#contatti-pubblica a[href="mailto:silviachine@gmail.com"]')).not.toBeNull();
        expect(app.$('#contatti-pubblica a[href^="https://www.instagram.com/"]')).not.toBeNull();
    });

    it('la navigazione punta a sezioni esistenti', async () => {
        app = await bootApp();
        const anchors = app.$$('#public-view nav a[href^="#"]');
        expect(anchors.length).toBe(7);
        for (const a of anchors) expect(app.byId(a.getAttribute('href').slice(1)), a.getAttribute('href')).not.toBeNull();
    });

    // Regressione (difetto corretto): i contenuti pubblici sono inseriti con innerHTML senza escape (XSS memorizzato
    // se un contenuto amministrativo o un dato Firestore contiene HTML).
    it('esegue l’escape dell’HTML nei contenuti pubblici', async () => {
        app = await bootApp({ docs: seedDocs({ news: [{ id: 'x', title: '<img src=x onerror=alert(1)>', content: 'c', date: '' }] }) });
        expect(app.$$('#public-news-grid img').length).toBe(0);
    });

    it('non crea link con URL pericolosi e neutralizza colori/icone malevoli', async () => {
        app = await bootApp({ docs: seedDocs({ publicCenters: [center({ id: 'x', name: '<b>Nome</b>', siteUrl: 'javascript:alert(1)', bookingUrl: 'https://ok.example', color: 'red;background:url(x)', icon: 'fa-x" onmouseover="alert(1)' })] }) });
        const card = app.$('#public-centers-grid > div');
        expect(card.querySelector('h4').textContent).toBe('<b>Nome</b>');
        expect(card.querySelectorAll('a').length).toBe(1);
        expect(card.querySelector('a').getAttribute('href')).toBe('https://ok.example');
        expect(card.querySelector('a').getAttribute('rel')).toBe('noopener noreferrer');
        expect(card.innerHTML).not.toContain('onmouseover');
        expect(card.innerHTML).toContain('background-color: #3f5e4e');
    });
});

describe('sito pubblico: indicizzazione e prestazioni', () => {
    const PLACEHOLDERS = /example\.com|Via Roma 10|Corso Italia 45|1234567|7654321|San Benedetto/;
    const PROMISE_WORDS = /tossin|detox|disintossic|depura|purific|guarigion|garantit|miracol|dimagr/i;

    it('se il database non risponde mostra le sedi reali, senza indirizzi o telefoni di prova', async () => {
        app = await bootApp({ initError: 'rete assente', waitForAuth: false });
        const centers = app.text('public-centers-grid');
        expect(centers).toContain('CMS Centro Medico Polispecialistico');
        expect(centers).toContain('Piazza Risorgimento 3, Carate Brianza');
        expect(centers).toContain('Centro Polisalute');
        expect(centers).toContain('Via E. de Amicis 67, Cinisello Balsamo');
        expect(app.$('#public-centers-grid a[href="https://cmscarate.com/"]')).not.toBeNull();
        expect(app.byId('public-view').textContent).not.toMatch(PLACEHOLDERS);
    });

    it('i testi predefiniti di trattamenti e preparazione sono informativi, senza promesse di risultato', async () => {
        app = await bootApp();
        for (const id of ['public-treatments-grid', 'public-preparations-grid']) expect(app.text(id)).not.toMatch(PROMISE_WORDS);
    });

    it('il calendario si scarica solo per l’area riservata: all’apertura dell’accesso, non per i visitatori', async () => {
        app = await bootApp({ beforeScript: (window) => { delete window.FullCalendar; } });
        const loader = () => app.document.querySelector('script[src="/assets/vendor/fullcalendar.min.js"]');
        expect(loader()).toBeNull();

        app.window.openLoginModal();
        expect(loader()).not.toBeNull();
        app.window.openLoginModal();
        expect(app.$$('script[src="/assets/vendor/fullcalendar.min.js"]')).toHaveLength(1);

        await app.login();
        expect(app.calendar).toBeFalsy(); // in attesa del file

        app.window.FullCalendar = { Calendar: FakeCalendar };
        loader().dispatchEvent(new app.window.Event('load'));
        await app.waitFor(() => app.calendar, 'calendario inizializzato');
        expect(FakeCalendar.instances).toHaveLength(1);
    });

    it('se il calendario non si scarica avvisa e permette di riprovare', async () => {
        app = await bootApp({ beforeScript: (window) => { delete window.FullCalendar; } });
        app.window.openLoginModal();
        app.$('script[src="/assets/vendor/fullcalendar.min.js"]').dispatchEvent(new app.window.Event('error'));
        await app.flush();
        await app.login();
        const retry = app.$$('script[src="/assets/vendor/fullcalendar.min.js"]').at(-1);
        retry.dispatchEvent(new app.window.Event('error'));
        await app.flush();
        expect(app.toast()).toContain('Calendario non caricato');
        expect(app.$$('script[src="/assets/vendor/fullcalendar.min.js"]')).toHaveLength(2);
    });
});
