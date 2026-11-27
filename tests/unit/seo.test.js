import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
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
        expect(locs).toEqual([SITE, `${SITE}osteopatia-carate-brianza.html`, `${SITE}idrocolonterapia-carate-brianza.html`, `${SITE}privacy.html`]);
        for (const loc of locs.slice(1)) expect(existsSync(path.join(ROOT, loc.slice(SITE.length)))).toBe(true);
        const privacy = new JSDOM(readFileSync(path.join(ROOT, 'privacy.html'), 'utf8')).window.document;
        expect(privacy.querySelector('link[rel="canonical"]').getAttribute('href')).toBe(`${SITE}privacy.html`);
    });
});

describe('pagine dei servizi (fase 2)', () => {
    const OSTEO = 'osteopatia-carate-brianza.html';
    const IDRO = 'idrocolonterapia-carate-brianza.html';
    const page = (file) => new JSDOM(readFileSync(path.join(ROOT, file), 'utf8')).window.document;
    const text = (doc) => { const body = doc.body.cloneNode(true); body.querySelectorAll('script').forEach(el => el.remove()); return body.textContent.replace(/\s+/g, ' '); };

    it('la home collega entrambe le pagine', () => {
        for (const file of [OSTEO, IDRO]) expect(document.querySelectorAll(`#public-view a[href="/${file}"]`).length, file).toBeGreaterThanOrEqual(2);
    });

    it('le due pagine si collegano tra loro e tornano alla home', () => {
        expect(page(OSTEO).querySelector(`a[href="/${IDRO}"]`)).not.toBeNull();
        expect(page(IDRO).querySelector(`a[href="/${OSTEO}"]`)).not.toBeNull();
        for (const file of [OSTEO, IDRO]) expect(page(file).querySelector('header a[href="/"]'), file).not.toBeNull();
    });

    it('osteopatia: titolo e h1 con la città, studio di Via San Giuseppe, prenotazione dal modulo', () => {
        const doc = page(OSTEO);
        expect(doc.title).toMatch(/^Osteopatia a Carate Brianza/);
        expect(doc.querySelector('h1').textContent).toContain('Carate Brianza');
        expect(text(doc)).toContain('Via San Giuseppe 25');
        expect(doc.querySelector('a[href="https://maps.app.goo.gl/KfM6Rqde9TN5TTxq7"]')).not.toBeNull();
        expect(doc.querySelector('main a[href="/#appointment-request"]')).not.toBeNull();
    });

    it('idrocolonterapia: entrambe le sedi e entrambe le strade per prenotare (centri e Silvia)', () => {
        const doc = page(IDRO);
        const content = text(doc);
        expect(doc.title).toMatch(/^Idrocolonterapia a Carate Brianza/);
        expect(doc.querySelector('h1').textContent).toMatch(/Carate Brianza.*Cinisello Balsamo/);
        expect(content).toContain('Piazza Risorgimento 3, 20841 Carate Brianza');
        expect(content).toContain('Via E. de Amicis 67, 20092 Cinisello Balsamo');
        expect(doc.querySelector('#sedi a[href="https://cmscarate.com/"]')).not.toBeNull();
        expect(doc.querySelector('#sedi a[href="https://www.miodottore.it/profilo/silvia-chinellato"]')).not.toBeNull();
        expect(doc.querySelector('#sedi a[href="/#appointment-request"]')).not.toBeNull();
    });

    it('idrocolonterapia: controindicazioni da verificare nel colloquio e rimando al medico', () => {
        const content = text(page(IDRO));
        expect(content).toContain('Quando non si esegue');
        expect(content).toContain('gravidanza');
        expect(content).toMatch(/non sostituisce le cure del medico/);
    });

    it('nessun prezzo pubblicato, né nelle pagine dei servizi né nella home (scelta di Silvia)', () => {
        for (const doc of [document, page(OSTEO), page(IDRO)]) {
            const root = doc.getElementById('public-view') || doc.body;
            const clone = root.cloneNode(true);
            clone.querySelectorAll('script').forEach(el => el.remove());
            expect(clone.textContent).not.toMatch(/€|\beuro\b|\d+\s*eur\b/i);
        }
    });
});
