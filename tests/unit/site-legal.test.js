/**
 * Requisiti legali della parte pubblica del sito (vedi PR "Sito pubblico: privacy, cookie e dati obbligatori"):
 *  - nessuna risorsa caricata da servizi esterni, tranne le librerie Firebase da www.gstatic.com;
 *  - CSS, font e icone serviti dal sito e aggiornati;
 *  - footer con dati del professionista e link all'informativa "Privacy e cookie";
 *  - testi informativi, senza promesse di risultato (pubblicità sanitaria, L. 145/2018 c. 525).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { ROOT, readIndexHtml } from '../support/app-source.js';
import { assertTailwindUpToDate } from '../support/build-tailwind.mjs';

const PAGES = { 'index.html': readIndexHtml(), 'privacy.html': readFileSync(path.join(ROOT, 'privacy.html'), 'utf8') };
const dom = (html) => new JSDOM(html).window.document;
/** Unici indirizzi esterni ammessi tra le risorse caricate automaticamente: Firebase (Google), già indicato nell'informativa. */
const ALLOWED_EXTERNAL = [/^https:\/\/www\.gstatic\.com\/firebasejs\//];

function loadedResources(html) {
    const document = dom(html);
    const urls = [
        ...[...document.querySelectorAll('script[src], img[src], iframe[src], source[src], video[src], audio[src]')].map(el => el.getAttribute('src')),
        ...[...document.querySelectorAll('link[href]')].filter(el => el.getAttribute('rel') !== 'canonical').map(el => el.getAttribute('href'))
    ];
    const moduleImports = [...html.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)].map(m => m[1]);
    const cssUrls = [...html.matchAll(/url\(\s*['"]?(https?:[^'")]+)/g)].map(m => m[1]);
    return [...urls, ...moduleImports, ...cssUrls];
}

describe('nessun servizio esterno caricato dalle pagine', () => {
    it.each(Object.keys(PAGES))('%s carica solo risorse del sito (e Firebase)', (name) => {
        const external = loadedResources(PAGES[name]).filter(url => /^(https?:)?\/\//.test(url) && !ALLOWED_EXTERNAL.some(re => re.test(url)));
        expect(external).toEqual([]);
    });

    it('niente Google Fonts, cdnjs, jsDelivr, Tailwind Play CDN o placeholder esterni', () => {
        for (const html of Object.values(PAGES)) {
            expect(html).not.toMatch(/fonts\.googleapis|fonts\.gstatic|cdnjs\.cloudflare|cdn\.jsdelivr|cdn\.tailwindcss|placehold\.co/);
        }
    });

    it('le risorse locali esistono', () => {
        for (const html of Object.values(PAGES)) {
            for (const url of loadedResources(html).filter(u => u.startsWith('/'))) {
                expect(existsSync(path.join(ROOT, decodeURIComponent(url))), url).toBe(true);
            }
        }
        const fontsCss = readFileSync(path.join(ROOT, 'assets/css/fonts.css'), 'utf8');
        const fonts = [...fontsCss.matchAll(/url\((\/assets\/fonts\/[^)]+)\)/g)].map(m => m[1]);
        expect(fonts.length).toBe(30);
        for (const font of fonts) expect(existsSync(path.join(ROOT, font)), font).toBe(true);
        expect(fontsCss).toContain("font-family: 'Cormorant Garamond'");
        expect(fontsCss).toContain("font-family: 'Plus Jakarta Sans'");
        const fa = readFileSync(path.join(ROOT, 'assets/fontawesome/css/all.min.css'), 'utf8');
        for (const font of [...fa.matchAll(/url\(\.\.\/webfonts\/([^)]+)\)/g)].map(m => m[1])) {
            expect(existsSync(path.join(ROOT, 'assets/fontawesome/webfonts', font)), font).toBe(true);
        }
    });

    it('il CSS Tailwind compilato è aggiornato rispetto alle pagine (npm run build:assets)', async () => {
        await expect(assertTailwindUpToDate()).resolves.toBeUndefined();
    }, 60000);
});

describe('dati obbligatori e informativa', () => {
    const index = dom(PAGES['index.html']);
    const privacy = dom(PAGES['privacy.html']);

    it('non restano segnaposto da compilare', () => {
        for (const [name, html] of Object.entries(PAGES)) expect(html.match(/\{\{[A-Z_]+\}\}/g), name).toBeNull();
    });

    it('il footer riporta partita IVA, dati del professionista e il link a "Privacy e cookie"', () => {
        const footer = index.getElementById('site-footer');
        expect(footer.textContent).toMatch(/P\.\s?IVA\s+\d{11}/);
        expect(footer.textContent).toContain('silviachine@gmail.com');
        expect(footer.querySelector('a[href="/privacy.html"]').textContent).toBe('Privacy e cookie');
    });

    it('l’informativa del modulo cita i fornitori e rimanda all’informativa completa', () => {
        const text = index.getElementById('request-privacy').textContent;
        expect(text).toContain('Vercel');
        expect(text).toContain('Google Firebase');
        expect(text).toMatch(/Stati Uniti/);
        expect(index.querySelector('#request-privacy a[href="/privacy.html"]')).not.toBeNull();
    });

    it('la pagina "Privacy e cookie" copre titolare, navigazione, modulo, cookie, destinatari e diritti', () => {
        for (const id of ['titolare', 'navigazione', 'modulo', 'contatti', 'link', 'cookie', 'destinatari', 'diritti']) {
            expect(privacy.getElementById(id), id).not.toBeNull();
        }
        const text = privacy.body.textContent;
        expect(text).toContain('non usa cookie di profilazione');
        expect(text).toContain('appointmentRequestSentAt');
        expect(text).toContain('Garante per la protezione dei dati personali');
        expect(text).toMatch(/P\.\s?IVA\s+\d{11}/);
        expect(privacy.querySelector('a[href="/"]')).not.toBeNull();
    });

    it('l’antispam salva in localStorage proprio la chiave descritta nell’informativa', () => {
        expect(PAGES['index.html']).toContain("'appointmentRequestSentAt'");
    });
});

describe('testi informativi, senza promesse di risultato', () => {
    const FORBIDDEN = /tossine|autoguarigione|sollievo duraturo|d'Eccellenza|Specialista in|armonia originaria|energia vitale|risolvere dolori|prevenzione dei disturbi cronici|depurazione/i;

    it.each(Object.keys(PAGES))('%s non contiene espressioni promozionali sulla salute', (name) => {
        const document = dom(PAGES[name]);
        document.querySelectorAll('script').forEach(s => s.remove());
        expect(document.body.textContent).not.toMatch(FORBIDDEN);
    });

    it('i testi predefiniti dei trattamenti sono informativi (i vecchi restano solo per sostituirli)', () => {
        const block = PAGES['index.html'].match(/const DEFAULT_TREATMENT_TEXTS = (\{[\s\S]*?\n {8}\});/)[1];
        const defaults = new Function(`return ${block};`)();
        for (const item of Object.values(defaults)) {
            expect(`${item.title} ${item.desc}`).not.toMatch(FORBIDDEN);
            expect(item.legacy.desc).toBeTruthy();
        }
    });
});
