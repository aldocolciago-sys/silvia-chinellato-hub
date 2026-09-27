import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { ROOT, readIndexHtml, getModuleScript, windowFunctionNames, topLevelFunctionNames, staticElementIds, parseModuleScript } from '../support/app-source.js';

const html = readIndexHtml();
const script = getModuleScript();
const staticIds = staticElementIds();
const dom = new JSDOM(html.replace(/<script[\s\S]*?<\/script>/g, ''));
const document = dom.window.document;

/** Nomi delle funzioni invocate negli attributi on* (sia nel markup sia nei template JS). */
function inlineHandlerCalls() {
    const calls = new Set();
    for (const match of html.matchAll(/\bon(?:click|submit|change|input|keyup|keydown)="([^"]+)"/g)) {
        const code = match[1];
        for (const call of code.matchAll(/(?:^|[;\s(!])([A-Za-z_$][\w$]*)\s*\(/g)) calls.add(call[1]);
    }
    return calls;
}

describe('integrità di index.html', () => {
    it('lo script principale è JavaScript valido (ES module)', () => {
        expect(() => parseModuleScript()).not.toThrow();
    });

    it('non contiene attributi con virgolette doppie errate (es. class=""px-4 ...)', () => {
        const broken = [...html.matchAll(/\s[\w-]+=""[^\s>]/g)].map(m => m[0].trim());
        expect(broken).toEqual([]);
    });

    it('non contiene id duplicati nel markup statico', () => {
        const duplicates = staticIds.filter((id, i) => staticIds.indexOf(id) !== i);
        expect(duplicates).toEqual([]);
    });

    it('ogni handler inline chiama una funzione esposta su window', () => {
        const allowed = new Set([...windowFunctionNames(), 'event', 'this', 'alert', 'if', 'mobileOpenAdmin', 'setTimeout']);
        const missing = [...inlineHandlerCalls()].filter(name => !allowed.has(name));
        expect(missing).toEqual([]);
    });

    it('ogni getElementById con id letterale punta a un elemento esistente', () => {
        const referenced = new Set([...script.matchAll(/getElementById\('([^'$`]+)'\)/g)].map(m => m[1]));
        const idSet = new Set(staticIds);
        const missing = [...referenced].filter(id => !idSet.has(id));
        expect(missing).toEqual([]);
    });

    it('ogni funzione passata a mobileOpenAdmin(...) esiste', () => {
        const names = [...html.matchAll(/mobileOpenAdmin\((\w+)\)/g)].map(m => m[1]);
        expect(names.length).toBeGreaterThan(0);
        const defined = new Set([...windowFunctionNames(), ...topLevelFunctionNames()]);
        expect(names.filter(n => !defined.has(n))).toEqual([]);
    });

    it('tutte le finestre modali sono nascoste al caricamento', () => {
        const modals = [...document.querySelectorAll('[id$="-modal"]')];
        expect(modals.length).toBeGreaterThanOrEqual(15);
        const visible = modals.filter(m => !m.classList.contains('hidden')).map(m => m.id);
        expect(visible).toEqual([]);
    });

    it('la vista pubblica è visibile e quella privata nascosta al caricamento', () => {
        expect(document.getElementById('public-view').classList.contains('hidden')).toBe(false);
        expect(document.getElementById('private-view').classList.contains('hidden')).toBe(true);
    });

    it('ogni form ha un handler onsubmit', () => {
        const forms = [...document.querySelectorAll('form')];
        expect(forms.length).toBeGreaterThan(0);
        expect(forms.filter(f => !f.getAttribute('onsubmit')).map(f => f.id)).toEqual([]);
    });

    it('le immagini locali referenziate esistono nel repository', () => {
        const sources = [...document.querySelectorAll('img')].map(img => img.getAttribute('src')).filter(src => !/^https?:/.test(src));
        expect(sources.length).toBeGreaterThan(0);
        for (const src of new Set(sources)) expect(existsSync(path.join(ROOT, decodeURIComponent(src))), src).toBe(true);
    });

    it('ha lingua italiana, charset UTF-8 e viewport responsive', () => {
        expect(document.documentElement.lang).toBe('it');
        expect(document.querySelector('meta[charset]').getAttribute('charset')).toBe('UTF-8');
        expect(document.querySelector('meta[name="viewport"]').content).toContain('width=device-width');
        expect(document.title).toContain('Silvia Chinellato');
    });

    it('usa versioni fissate per le librerie da CDN', () => {
        expect(html).toContain('fullcalendar@6.1.8');
        const firebaseVersions = new Set([...script.matchAll(/firebasejs\/([\d.]+)\//g)].map(m => m[1]));
        expect(firebaseVersions.size).toBe(1);
    });

    it('elenca le email autorizzate in minuscolo', () => {
        const match = script.match(/const AUTHORIZED_EMAILS = \[([^\]]+)\]/);
        const emails = [...match[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
        expect(emails.length).toBeGreaterThan(0);
        for (const email of emails) {
            expect(email).toBe(email.toLowerCase());
            expect(email).toMatch(/^[^@\s]+@[^@\s]+\.[a-z]+$/);
        }
    });

    it('i link esterni aperti in nuova scheda nel markup statico sono sicuri', () => {
        const links = [...document.querySelectorAll('a[target="_blank"]')];
        for (const a of links) expect(a.getAttribute('href')).toMatch(/^https:\/\//);
    });
});

describe('configurazione Vercel', () => {
    const config = JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));

    it('è JSON valido con rewrite verso file esistenti', () => {
        expect(Array.isArray(config.rewrites)).toBe(true);
        for (const rewrite of config.rewrites) {
            expect(rewrite.source).toMatch(/^\//);
            expect(existsSync(path.join(ROOT, rewrite.destination))).toBe(true);
        }
    });

    it('instrada /api/ical verso la funzione serverless', () => {
        expect(config.rewrites).toContainEqual({ source: '/api/ical', destination: '/api/ical.js' });
    });
});
