import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { ROOT } from '../support/app-source.js';

/**
 * Regole che valgono per TUTTE le pagine HTML pubblicate, presenti e future
 * (es. pagine dedicate a osteopatia e idrocolonterapia, agenda separata dal sito pubblico).
 * Una nuova pagina viene controllata automaticamente appena aggiunta al repository.
 */
const SITE = 'https://silvia-chinellato-hub.vercel.app/';
/** Pagine legali: indicizzabili, ma senza anteprima social né regole sui testi sanitari. */
const LEGAL_PAGES = new Set(['privacy.html']);
/** Cartelle che non contengono pagine del sito. */
const NON_PAGE_DIRS = new Set(['node_modules', 'tests', 'coverage', 'playwright-report', 'test-results', '.git', '.github', 'scripts', 'api', 'lib', 'assets']);
/** Dati che il sito non pubblica di proposito: il telefono di Silvia resta nascosto. */
const P_IVA = '13070370963';
const OPI_NUMBER = '31189';
/**
 * Pubblicità sanitaria: solo testi informativi, nessuna promessa di risultato.
 * Le parole qui sotto, nelle pagine statiche, sono quasi sempre il segnale di una promessa.
 */
const PROMISE_WORDS = /tossin|detox|disintossic|depura|purific|guarigion|garantit|miracol|dimagr|risultati assicurati/i;

const vercelConfig = JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const cleanUrls = vercelConfig.cleanUrls === true;

/** Converte i pattern di .vercelignore (cartelle, file, glob con *) in una funzione di confronto. */
const ignorePatterns = readFileSync(path.join(ROOT, '.vercelignore'), 'utf8')
    .split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
function isVercelIgnored(relPath) {
    return ignorePatterns.some(pattern => {
        if (pattern.endsWith('/')) return relPath === pattern.slice(0, -1) || relPath.startsWith(pattern);
        const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
        return regex.test(relPath) || regex.test(path.basename(relPath));
    });
}

function findHtmlFiles(dir = ROOT, rel = '') {
    const files = [];
    for (const name of readdirSync(dir)) {
        const relPath = rel ? `${rel}/${name}` : name;
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) {
            if (!NON_PAGE_DIRS.has(name) && !name.startsWith('.')) files.push(...findHtmlFiles(full, relPath));
        } else if (name.endsWith('.html') && !isVercelIgnored(relPath)) {
            files.push(relPath);
        }
    }
    return files.sort();
}

/** Indirizzo pubblico di un file, tenendo conto di cleanUrls in vercel.json. */
function urlForFile(file) {
    if (file === 'index.html') return SITE;
    if (file.endsWith('/index.html')) return SITE + file.slice(0, -'index.html'.length);
    return SITE + (cleanUrls ? file.replace(/\.html$/, '') : file);
}

/** File servito per un percorso del sito ('/', '/privacy.html', '/osteopatia', '/cartella/'). */
function fileForPath(urlPath) {
    const p = decodeURIComponent(urlPath.replace(/^\//, ''));
    if (p === '' || p.endsWith('/')) return `${p}index.html`;
    if (path.extname(p)) return p;
    return `${p}.html`;
}

function loadPage(file) {
    const raw = readFileSync(path.join(ROOT, file), 'utf8');
    const document = new JSDOM(raw).window.document; // gli script non vengono eseguiti
    const meta = (selector) => document.querySelector(selector)?.getAttribute('content') ?? null;
    /** Parte visibile ai visitatori: nella home esclude l'area riservata e le finestre modali. */
    const publicRoot = document.getElementById('public-view') || document.body;
    const visible = publicRoot.cloneNode(true);
    visible.querySelectorAll('script, style, template').forEach(el => el.remove());
    const jsonLd = [...document.querySelectorAll('script[type="application/ld+json"]')].map(s => s.textContent);
    return {
        file,
        raw,
        document,
        meta,
        publicRoot,
        text: visible.textContent.replace(/\s+/g, ' '),
        jsonLd,
        url: urlForFile(file),
        canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null,
        noindex: /noindex/i.test(meta('meta[name="robots"]') || ''),
        legal: LEGAL_PAGES.has(file)
    };
}

const sitemap = readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');
const sitemapUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim());
const pages = findHtmlFiles().map(loadPage);
const indexable = pages.filter(p => !p.noindex);
const servicePages = indexable.filter(p => !p.legal);
const localFile = (url) => path.join(ROOT, fileForPath(new URL(url).pathname));

describe('elenco delle pagine', () => {
    it('trova almeno la home e l\'informativa privacy', () => {
        expect(pages.map(p => p.file)).toEqual(expect.arrayContaining(['index.html', 'privacy.html']));
    });

    it('ogni pagina è nella sitemap oppure è esclusa da Google con noindex (es. un\'agenda separata)', () => {
        const orphans = pages.filter(p => !sitemapUrls.includes(p.url) && !p.noindex).map(p => p.file);
        expect(orphans, 'aggiungere la pagina a sitemap.xml o metterle <meta name="robots" content="noindex">').toEqual([]);
    });

    it('le pagine escluse con noindex non sono nella sitemap', () => {
        expect(pages.filter(p => p.noindex && sitemapUrls.includes(p.url)).map(p => p.file)).toEqual([]);
    });

    it('ogni indirizzo della sitemap è una pagina pubblicata, unico, con canonico identico', () => {
        expect(new Set(sitemapUrls).size).toBe(sitemapUrls.length);
        for (const url of sitemapUrls) {
            expect(url.startsWith(SITE), url).toBe(true);
            const page = pages.find(p => p.url === url);
            expect(page, `${url}: nessun file corrispondente (o escluso da .vercelignore)`).toBeTruthy();
            expect(page.canonical, url).toBe(url);
        }
    });

    it('robots.txt non blocca nessuna pagina della sitemap', () => {
        const robots = readFileSync(path.join(ROOT, 'robots.txt'), 'utf8');
        const disallowed = [...robots.matchAll(/^Disallow:\s*(\S+)/gm)].map(m => m[1]);
        for (const url of sitemapUrls) {
            const urlPath = new URL(url).pathname;
            expect(disallowed.filter(prefix => urlPath.startsWith(prefix)), url).toEqual([]);
        }
    });

    it('.vercelignore non esclude i file che servono a Google e alle anteprime', () => {
        const needed = ['robots.txt', 'sitemap.xml', 'favicon.ico', 'apple-touch-icon.png', 'assets/img/icon-192.png'];
        for (const page of pages) {
            const ogImage = page.meta('meta[property="og:image"]');
            if (ogImage) needed.push(fileForPath(new URL(ogImage).pathname));
        }
        expect(needed.filter(isVercelIgnored)).toEqual([]);
        for (const file of needed) expect(existsSync(path.join(ROOT, file)), file).toBe(true);
    });
});

describe.each(pages.map(p => [p.file, p]))('%s', (file, page) => {
    it('è in italiano, con titolo, un solo h1 e icona del sito', () => {
        expect(page.document.documentElement.lang).toBe('it');
        expect(page.document.title.trim().length).toBeGreaterThan(0);
        expect(page.document.querySelectorAll('h1')).toHaveLength(1);
        const icon = page.document.querySelector('link[rel="icon"]')?.getAttribute('href');
        expect(icon).toBe('/favicon.ico');
    });

    it('i link interni portano a pagine e sezioni esistenti', () => {
        const broken = [];
        for (const a of page.document.querySelectorAll('a[href]')) {
            const href = a.getAttribute('href');
            if (/^(https?:|mailto:|tel:|javascript:)/i.test(href) || href === '#') continue;
            const [target, hash] = href.split('#');
            const targetFile = target ? fileForPath(new URL(target, page.url).pathname) : file;
            if (!existsSync(path.join(ROOT, targetFile))) { broken.push(href); continue; }
            if (hash) {
                const targetDoc = targetFile === file ? page.document : loadPage(targetFile).document;
                if (!targetDoc.getElementById(hash)) broken.push(href);
            }
        }
        expect(broken).toEqual([]);
    });

    it('i link esterni che aprono una nuova scheda usano rel="noopener"', () => {
        const unsafe = [...page.document.querySelectorAll('a[target="_blank"][href^="http"]')]
            .filter(a => !/noopener|noreferrer/.test(a.getAttribute('rel') || ''))
            .map(a => a.getAttribute('href'));
        expect(unsafe).toEqual([]);
    });

    it('non pubblica il telefono: niente link tel: o WhatsApp e niente "telephone" nei dati strutturati', () => {
        const phoneLinks = [...page.publicRoot.querySelectorAll('a[href]')].map(a => a.getAttribute('href')).filter(h => /^tel:|wa\.me\/|api\.whatsapp\.com/i.test(h));
        expect(phoneLinks).toEqual([]);
        for (const json of page.jsonLd) expect(json).not.toMatch(/"telephone"/);
    });

    it('i dati strutturati sono JSON valido', () => {
        for (const json of page.jsonLd) expect(() => JSON.parse(json)).not.toThrow();
    });

    it('nessuno script blocca la visualizzazione della pagina dal <head>', () => {
        const blocking = [...page.document.head.querySelectorAll('script[src]')]
            .filter(s => s.getAttribute('type') !== 'module' && !s.hasAttribute('async') && !s.hasAttribute('defer'))
            .map(s => s.getAttribute('src'));
        expect(blocking).toEqual([]);
    });

    it('le immagini hanno testo alternativo, dimensioni dichiarate e peso contenuto', () => {
        for (const img of page.publicRoot.querySelectorAll('img')) {
            const src = img.getAttribute('src');
            expect(img.getAttribute('alt')?.trim(), `${src}: alt mancante`).toBeTruthy();
            expect(img.getAttribute('width'), `${src}: width mancante`).toMatch(/^\d+$/);
            expect(img.getAttribute('height'), `${src}: height mancante`).toMatch(/^\d+$/);
            if (/^https?:/.test(src)) continue;
            const local = path.join(ROOT, fileForPath(new URL(src, page.url).pathname));
            expect(existsSync(local), src).toBe(true);
            expect(statSync(local).size, `${src}: oltre 200 KB, va ridotta`).toBeLessThanOrEqual(200 * 1024);
        }
    });
});

describe.each(indexable.map(p => [p.file, p]))('%s (indicizzabile)', (file, page) => {
    it('ha canonico, titolo e descrizione di lunghezza adatta ai risultati di Google', () => {
        expect(page.canonical).toBe(page.url);
        expect(page.document.title.length).toBeGreaterThanOrEqual(15);
        expect(page.document.title.length).toBeLessThanOrEqual(70);
        const description = page.meta('meta[name="description"]');
        expect(description?.length ?? 0).toBeGreaterThanOrEqual(70);
        expect(description.length).toBeLessThanOrEqual(160);
    });
});

describe('titoli e descrizioni', () => {
    it('sono diversi tra una pagina e l\'altra', () => {
        const titles = indexable.map(p => p.document.title);
        const descriptions = indexable.map(p => p.meta('meta[name="description"]'));
        expect(new Set(titles).size).toBe(titles.length);
        expect(new Set(descriptions).size).toBe(descriptions.length);
    });
});

describe.each(servicePages.map(p => [p.file, p]))('%s (pagina dei servizi)', (file, page) => {
    it('ha l\'anteprima per i link condivisi, con immagine sotto i 300 KB richiesti da WhatsApp', () => {
        expect(page.meta('meta[property="og:title"]')).toBeTruthy();
        expect(page.meta('meta[property="og:description"]')).toBeTruthy();
        expect(page.meta('meta[property="og:url"]')).toBe(page.url);
        const image = page.meta('meta[property="og:image"]');
        expect(image?.startsWith(SITE), 'og:image deve essere un indirizzo assoluto del sito').toBe(true);
        const local = localFile(image);
        expect(existsSync(local), image).toBe(true);
        expect(statSync(local).size).toBeLessThan(300 * 1024);
    });

    it('mostra i dati obbligatori del professionista (P.IVA e iscrizione OPI)', () => {
        const footer = page.document.querySelector('footer')?.textContent || '';
        expect(footer).toContain(P_IVA);
        expect(footer).toContain(OPI_NUMBER);
        expect(page.document.querySelector('a[href="/privacy.html"]'), 'link all\'informativa privacy').not.toBeNull();
    });

    it('nome, indirizzo e P.IVA dei dati strutturati coincidono con il piè di pagina', () => {
        const footer = (page.document.querySelector('footer')?.textContent || '').replace(/\s+/g, ' ');
        const items = page.jsonLd.flatMap(json => { const data = JSON.parse(json); return data['@graph'] || [data]; });
        for (const business of items.filter(item => /Business|Clinic|Physician/.test(item['@type']) && item.address?.streetAddress && !item.name?.includes('Polisalute') && !item.name?.includes('CMS'))) {
            const { streetAddress, postalCode, addressLocality } = business.address;
            expect(footer).toContain(`${streetAddress}, ${postalCode} ${addressLocality}`);
            if (business.vatID) expect(footer).toContain(business.vatID.replace(/^IT/, ''));
        }
    });

    it('usa testi informativi, senza promesse di risultato (pubblicità sanitaria)', () => {
        const match = page.text.match(new RegExp(`.{0,40}(${PROMISE_WORDS.source}).{0,40}`, 'i'));
        expect(match?.[0] ?? null, 'riformulare in modo informativo').toBeNull();
    });
});
