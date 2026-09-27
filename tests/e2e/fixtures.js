/**
 * Fixture Playwright condivise.
 *
 * Ogni pagina viene eseguita completamente offline e in modo deterministico:
 *  - Firebase (app/auth/firestore) → mock in-memory (tests/mocks/firebase), stato seminato per test;
 *  - Tailwind Play CDN → CSS precompilato (tests/.cache, generato in global-setup);
 *  - FullCalendar → copia npm della stessa versione (6.1.8);
 *  - font, icone e placeholder esterni → risposte vuote;
 *  - qualunque altra richiesta verso Internet → bloccata (e registrata in `blockedRequests`).
 */
import { test as base, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../support/app-source.js';
import { STUB_PATH } from '../support/build-tailwind.mjs';
import { AUTHORIZED_EMAIL } from '../fixtures/seed.js';

const FIREBASE_MOCK_DIR = path.join(ROOT, 'tests', 'mocks', 'firebase');
const FULLCALENDAR_JS = path.join(ROOT, 'node_modules', 'fullcalendar', 'index.global.min.js');
const GOOGLE_SVG = path.join(ROOT, 'tests', 'mocks', 'google.svg');

const cache = new Map();
function file(p) {
    if (!cache.has(p)) cache.set(p, readFileSync(p));
    return cache.get(p);
}

const CORS = { 'access-control-allow-origin': '*' };

export async function installOfflineRoutes(page, blockedRequests) {
    await page.route(url => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url.href), async (route) => {
        const url = new URL(route.request().url());
        const host = url.hostname;
        if (host === 'cdn.tailwindcss.com') {
            return route.fulfill({ status: 200, contentType: 'text/javascript', body: file(STUB_PATH) });
        }
        if (host === 'cdn.jsdelivr.net' && url.pathname.includes('fullcalendar@6.1.8/index.global.min.js')) {
            return route.fulfill({ status: 200, contentType: 'text/javascript', body: file(FULLCALENDAR_JS) });
        }
        if (host === 'cdn.jsdelivr.net' && url.pathname.endsWith('.css')) {
            return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
        }
        if (host === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/') && url.pathname.endsWith('.js')) {
            const name = path.basename(url.pathname);
            return route.fulfill({ status: 200, contentType: 'text/javascript', headers: CORS, body: file(path.join(FIREBASE_MOCK_DIR, name)) });
        }
        if (host === 'www.gstatic.com' && url.pathname.endsWith('.svg')) {
            return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: file(GOOGLE_SVG) });
        }
        if (['fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com'].includes(host)) {
            return route.fulfill({ status: 200, contentType: 'text/css', headers: CORS, body: '' });
        }
        blockedRequests.push(url.href);
        return route.abort('blockedbyclient');
    });
}

export const test = base.extend({
    /** Documenti Firestore iniziali e utente restituito dal popup Google: { docs, popupUser }. */
    firebaseSeed: [{ docs: {}, popupUser: { email: AUTHORIZED_EMAIL, uid: `uid-${AUTHORIZED_EMAIL}` } }, { option: true }],
    blockedRequests: async ({}, use) => { await use([]); },
    pageErrors: async ({}, use) => { await use([]); },
    page: async ({ page, firebaseSeed, blockedRequests, pageErrors }, use) => {
        await installOfflineRoutes(page, blockedRequests);
        page.on('pageerror', err => pageErrors.push(err));
        await page.addInitScript(seed => { window.__FIREBASE_MOCK_SEED__ = seed; }, firebaseSeed);
        await use(page);
    }
});

export { expect };

/** Accesso all'API di controllo del mock Firebase dentro la pagina. */
export function firestore(page) {
    return {
        get: (p) => page.evaluate(x => window.__firebaseMock.get(x), p),
        has: (p) => page.evaluate(x => window.__firebaseMock.has(x), p),
        list: (p) => page.evaluate(x => window.__firebaseMock.list(x), p),
        seed: (docs) => page.evaluate(d => window.__firebaseMock.seed(d), docs),
        failNext: (op, p) => page.evaluate(([o, x]) => window.__firebaseMock.failNext(o, x), [op, p]),
        setPopupUser: (u) => page.evaluate(x => window.__firebaseMock.setPopupUser(x), u)
    };
}

export const isMobile = (page) => (page.viewportSize()?.width || 1024) < 768;

/** Apre il sito e attende che l'autenticazione anonima sia pronta. */
export async function openSite(page) {
    await page.goto('/');
    await expect(page.locator('#public-firebase-text')).toHaveText('Connesso');
}

/** Login tramite UI con il popup Google simulato; chiude il report della sincronizzazione automatica. */
export async function loginViaUi(page, { closeReport = true } = {}) {
    await openSite(page);
    await page.getByRole('button', { name: 'Area Riservata' }).click();
    await expect(page.locator('#login-modal')).toBeVisible();
    await page.getByRole('button', { name: 'Accedi con Google' }).click();
    await expect(page.locator('#private-view')).toBeVisible();
    await expect(page.locator('#sync-modal-title')).toHaveText('Sincronizzazione completata');
    if (closeReport) {
        await page.locator('#sync-modal-footer button').click();
        await expect(page.locator('#sync-report-modal')).toBeHidden();
    }
}

/** Data locale YYYY-MM-DD spostata di `days` giorni rispetto ad oggi (fuso del browser: Europe/Rome). */
export function localDate(days = 0) {
    const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Rome' }));
    d.setDate(d.getDate() + days);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
