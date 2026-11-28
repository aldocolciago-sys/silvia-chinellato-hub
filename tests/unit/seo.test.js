import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { ROOT, readIndexHtml } from '../support/app-source.js';

/**
 * Basi per i motori di ricerca e per le anteprime dei link condivisi:
 * titolo e descrizione con servizi e città, indirizzo canonico, sitemap, dati strutturati.
 */
const SITE = 'https://silvia-chinellato-hub.vercel.app/';
const html = readIndexHtml();
const document = new JSDOM(html).window.document;
const meta = (selector) => document.querySelector(selector)?.getAttribute('content');
const jsonLd = () => JSON.parse(document.querySelector('script[type="application/ld+json"]').textContent);
const graphItem = (type) => jsonLd()['@graph'].find(item => item['@type'] === type);

describe('SEO della home', () => {
    it('titolo e descrizione citano servizi e città, con lunghezze adatte ai risultati di Google', () => {
        expect(document.title).toContain('Silvia Chinellato');
        expect(document.title).toContain('Carate Brianza');
        expect(document.title.length).toBeLessThanOrEqual(70);
        const description = meta('meta[name="description"]');
        expect(description).toMatch(/osteopata/i);
        expect(description).toMatch(/idrocolonterapia/i);
        expect(description).toContain('Carate Brianza');
        expect(description.length).toBeGreaterThanOrEqual(70);
        expect(description.length).toBeLessThanOrEqual(160);
    });

    it('mantiene il tag di verifica di Google Search Console (toglierlo fa perdere l\'accesso ai dati)', () => {
        expect(meta('meta[name="google-site-verification"]')).toMatch(/^[\w-]{20,}$/);
    });

    it('dichiara l\'indirizzo canonico ed è indicizzabile', () => {
        expect(document.querySelector('link[rel="canonical"]').getAttribute('href')).toBe(SITE);
        expect(meta('meta[name="robots"]')).toMatch(/^index, follow/);
    });

    it('ha un solo titolo principale (h1), con nome e città', () => {
        const h1 = [...document.querySelectorAll('h1')];
        expect(h1).toHaveLength(1);
        expect(h1[0].textContent).toContain('Silvia Chinellato');
        expect(h1[0].textContent).toContain('Carate Brianza');
        expect(h1[0].closest('#profilo-pubblica')).not.toBeNull();
    });

    it('nomina le sedi nel testo fisso della pagina, senza aspettare il database', () => {
        const text = document.getElementById('public-view').textContent.replace(/\s+/g, ' ');
        for (const place of ['Via San Giuseppe 25', 'CMS', 'Piazza Risorgimento 3', 'Centro Polisalute', 'Cinisello Balsamo']) expect(text).toContain(place);
    });

    it('i contenuti di riserva non contengono indirizzi, telefoni o link inventati', () => {
        expect(html).not.toMatch(/Via Roma 10|Corso Italia 45|02 1234567|039 7654321|example\.com/);
    });

    it('l\'anteprima dei link (Open Graph) usa indirizzi assoluti e un\'immagine esistente', () => {
        expect(meta('meta[property="og:url"]')).toBe(SITE);
        expect(meta('meta[property="og:title"]')).toContain('Silvia Chinellato');
        expect(meta('meta[property="og:description"]')).toBeTruthy();
        const image = meta('meta[property="og:image"]');
        expect(image.startsWith(SITE)).toBe(true);
        expect(existsSync(path.join(ROOT, image.slice(SITE.length)))).toBe(true);
        expect(meta('meta[name="twitter:card"]')).toBe('summary_large_image');
    });

    it('le icone del sito esistono', () => {
        const hrefs = [...document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]')].map(l => l.getAttribute('href'));
        expect(hrefs).toContain('/favicon.ico');
        for (const href of hrefs) expect(existsSync(path.join(ROOT, href)), href).toBe(true);
    });

    it('le immagini principali dichiarano larghezza e altezza (niente salti di impaginazione)', () => {
        const images = [...document.querySelectorAll('#public-view img')];
        expect(images.length).toBeGreaterThan(0);
        for (const img of images) {
            expect(img.getAttribute('width'), img.getAttribute('src')).toMatch(/^\d+$/);
            expect(img.getAttribute('height'), img.getAttribute('src')).toMatch(/^\d+$/);
        }
    });
});

describe('dati strutturati (schema.org)', () => {
    it('sono JSON valido con studio, professionista e sito', () => {
        const types = jsonLd()['@graph'].map(item => item['@type']);
        expect(types).toEqual(expect.arrayContaining(['WebSite', 'MedicalBusiness', 'Person']));
    });

    it('lo studio ha l\'indirizzo di Carate Brianza e la scheda Google Maps, ma nessun telefono', () => {
        const studio = graphItem('MedicalBusiness');
        expect(studio.address).toMatchObject({ streetAddress: 'Via San Giuseppe 25', postalCode: '20841', addressLocality: 'Carate Brianza', addressCountry: 'IT' });
        expect(studio.hasMap).toMatch(/^https:\/\/maps\.app\.goo\.gl\//);
        expect(JSON.stringify(jsonLd())).not.toMatch(/telephone/);
    });

    it('la professionista lavora nello studio, al CMS di Carate Brianza e al Centro Polisalute di Cinisello Balsamo', () => {
        const person = graphItem('Person');
        expect(person.name).toBe('Silvia Chinellato');
        const places = person.workLocation.map(place => place.name || place['@id']);
        expect(places).toEqual([`${SITE}#studio`, 'CMS Centro Medico Polispecialistico', 'Centro Polisalute']);
        expect(person.workLocation[1].address).toMatchObject({ streetAddress: 'Piazza Risorgimento 3', addressLocality: 'Carate Brianza' });
        expect(person.workLocation[2].address).toMatchObject({ streetAddress: 'Via E. de Amicis 67', addressLocality: 'Cinisello Balsamo' });
    });

    it('i dati coincidono con quelli obbligatori del piè di pagina (P.IVA e iscrizione OPI)', () => {
        const footer = document.getElementById('footer-legal-data').textContent;
        expect(footer).toContain(graphItem('MedicalBusiness').vatID.replace(/^IT/, ''));
        expect(footer).toContain('31189');
        expect(JSON.stringify(graphItem('Person').hasCredential)).toContain('31189');
    });
});

describe('robots.txt e sitemap.xml', () => {
    const robots = readFileSync(path.join(ROOT, 'robots.txt'), 'utf8');
    const sitemap = readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');

    it('robots.txt permette l\'indicizzazione del sito, esclude le API e indica la sitemap', () => {
        expect(robots).toMatch(/^User-agent: \*$/m);
        expect(robots).toMatch(/^Allow: \/$/m);
        expect(robots).toMatch(/^Disallow: \/api\/$/m);
        expect(robots).toContain(`Sitemap: ${SITE}sitemap.xml`);
    });

    it('la sitemap elenca le pagine pubbliche esistenti con indirizzi canonici', () => {
        const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
        expect(locs).toEqual([SITE, `${SITE}privacy.html`]);
        for (const loc of locs.slice(1)) expect(existsSync(path.join(ROOT, loc.slice(SITE.length)))).toBe(true);
        const privacy = new JSDOM(readFileSync(path.join(ROOT, 'privacy.html'), 'utf8')).window.document;
        expect(privacy.querySelector('link[rel="canonical"]').getAttribute('href')).toBe(`${SITE}privacy.html`);
    });
});

describe('home: struttura invariata e domande frequenti', () => {
    const sectionIds = () => [...document.querySelectorAll('#public-view main > section[id]')].map(section => section.id);

    it('la struttura resta quella di sempre: stesse sezioni, nello stesso ordine, con le parti gestite da Silvia', () => {
        expect(sectionIds()).toEqual(['profilo-pubblica', 'filosofia-pubblica', 'trattamenti-pubblica', 'domande-frequenti', 'poliambulatori-pubblica', 'news-pubblica', 'preparazione-pubblica', 'contatti-pubblica']);
        for (const id of ['public-treatments-grid', 'public-centers-grid', 'public-news-grid', 'public-preparations-grid', 'appointment-request-form']) {
            expect(document.getElementById(id), id).not.toBeNull();
        }
    });

    it('il sito resta su una sola pagina pubblica (più l\'informativa privacy)', () => {
        const pages = readdirSync(ROOT).filter(f => f.endsWith('.html')).sort();
        expect(pages).toEqual(['index.html', 'privacy.html']);
    });

    it('le domande frequenti coprono entrambi i trattamenti, con sedi, indirizzi e modi per prenotare', () => {
        const faq = document.getElementById('domande-frequenti');
        const text = faq.textContent.replace(/\s+/g, ' ');
        expect([...faq.querySelectorAll('h3')].map(h => h.textContent.trim())).toEqual(['Osteopatia a Carate Brianza', 'Idrocolonterapia a Carate Brianza e Cinisello Balsamo']);
        for (const place of ['Via San Giuseppe 25, 20841 Carate Brianza', 'Piazza Risorgimento 3, Carate Brianza', 'Via E. de Amicis 67, Cinisello Balsamo']) expect(text).toContain(place);
        for (const href of ['https://maps.app.goo.gl/KfM6Rqde9TN5TTxq7', '#poliambulatori-pubblica', '#appointment-request', '#preparazione-pubblica']) {
            expect(faq.querySelector(`a[href="${href}"]`), href).not.toBeNull();
        }
        expect(text).toContain('Quando non si esegue?');
        expect(text).toMatch(/non sostituisce (la diagnosi e )?le cure del medico/);
    });

    it('ogni domanda è un elenco apribile con testo di risposta', () => {
        const items = [...document.querySelectorAll('#domande-frequenti details.faq-item')];
        expect(items.length).toBeGreaterThanOrEqual(8);
        for (const item of items) {
            expect(item.querySelector('summary').textContent.trim()).toMatch(/\?$/);
            expect(item.querySelector('summary + .faq-answer p').textContent.trim().length).toBeGreaterThan(20);
        }
    });

    it('nessun prezzo pubblicato nella home (scelta di Silvia)', () => {
        const visible = document.getElementById('public-view').cloneNode(true);
        visible.querySelectorAll('script').forEach(el => el.remove());
        expect(visible.textContent).not.toMatch(/€|\beuro\b|\d+\s*eur\b/i);
    });
});
