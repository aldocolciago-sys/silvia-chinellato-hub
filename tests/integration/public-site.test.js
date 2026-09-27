import { describe, it, expect, afterEach } from 'vitest';
import { bootApp } from '../support/jsdom-app.js';
import { seedDocs, center } from '../fixtures/seed.js';

let app;
afterEach(() => app?.close());

describe('sito pubblico', () => {
    it('mostra i contenuti predefiniti se Firestore è vuoto', async () => {
        app = await bootApp();
        expect(app.$$('#public-treatments-grid > div').map(d => d.querySelector('h4').textContent))
            .toEqual(['Idrocolonterapia', 'Osteopatia', 'Prevenzione & Equilibrio']);
        expect(app.$$('#public-centers-grid > div').length).toBe(2);
        expect(app.$$('#public-news-grid > div').length).toBe(1);
        expect(app.$$('#public-preparations-grid > div').length).toBe(1);
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
        expect(centerCard.textContent).not.toContain('Prenota Online');
        expect(app.text('public-treatments-grid')).toContain('Massaggio viscerale');
        expect(app.text('public-news-grid')).toContain('1 marzo 2030');
        expect(app.$('#public-news-grid a[href="https://example.com/news"]')).not.toBeNull();
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
