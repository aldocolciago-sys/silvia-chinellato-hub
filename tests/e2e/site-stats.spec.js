import AxeBuilder from '@axe-core/playwright';
import { test, expect, openSite, loginViaUi, isMobile } from './fixtures.js';
import { seedDocs, SHARED, AUTHORIZED_EMAIL } from '../fixtures/seed.js';

/** Statistiche di visita: segnali dalla pagina pubblica e finestra nell'area riservata. */

// Registra i segnali inviati con sendBeacon (che restano inviati davvero al server di prova).
async function recordBeacons(page) {
    await page.addInitScript(() => {
        window.__beacons = [];
        const original = navigator.sendBeacon?.bind(navigator);
        navigator.sendBeacon = (url, data) => {
            if (data && typeof data.text === 'function') data.text().then(t => window.__beacons.push({ url, body: JSON.parse(t) }));
            return original ? original(url, data) : false;
        };
    });
}
const beacons = (page) => page.evaluate(() => window.__beacons);

function romeKey(offsetDays = 0) {
    const d = new Date(Date.now() + offsetDays * 86400000);
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d).map(x => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
}

test.describe('sito pubblico: segnali anonimi', () => {
    test('all\'apertura invia la visita al sito stesso, senza cookie', async ({ page, blockedRequests }) => {
        await recordBeacons(page);
        const request = page.waitForRequest(r => r.url().endsWith('/api/statistiche') && r.method() === 'POST');
        await openSite(page);
        await request;
        await expect.poll(() => beacons(page)).toContainEqual({ url: '/api/statistiche', body: { tipo: 'pagina', percorso: '/', provenienza: '', utm: '', nuovaVisita: true } });
        expect(await page.context().cookies()).toEqual([]);
        expect(blockedRequests).toEqual([]);
    });

    test('aprire una domanda frequente invia l\'evento con il testo della domanda', async ({ page }) => {
        await recordBeacons(page);
        await openSite(page);
        await page.locator('#domande-frequenti').getByText('Quando non si esegue?').click();
        await expect.poll(() => beacons(page)).toContainEqual({ url: '/api/statistiche', body: { tipo: 'evento', nome: 'faq', dettaglio: 'Quando non si esegue?' } });
    });

    test('dopo l\'accesso all\'area riservata il dispositivo non viene più contato', async ({ page }) => {
        await loginViaUi(page);
        expect(await page.evaluate(() => localStorage.getItem('statisticheIgnoraDispositivo'))).toBe('1');
        await recordBeacons(page);
        await page.goto('/');
        await page.waitForLoadState('load');
        await page.waitForTimeout(300);
        expect(await beacons(page)).toEqual([]);
    });
});

test.describe('area riservata: statistiche del sito', () => {
    test.use({
        firebaseSeed: {
            docs: seedDocs({
                extra: {
                    [`${SHARED}/site_stats/${romeKey(0)}`]: { date: romeKey(0), visits: 3, views: 5, sources: { google: 2, diretto: 1 }, devices: { telefono: 3 }, places: { 'Carate Brianza': 3 }, hours: { '10': 3 }, events: { richiesta_appuntamento: 1 } },
                    [`${SHARED}/site_stats/${romeKey(-2)}`]: { date: romeKey(-2), visits: 2, views: 2, sources: { instagram: 2 }, devices: { computer: 2 }, places: { Seregno: 2 } }
                }
            }),
            popupUser: { email: AUTHORIZED_EMAIL, uid: `uid-${AUTHORIZED_EMAIL}` }
        }
    });

    test('si apre dal menu e mostra totali, grafico e provenienze; accessibile', async ({ page }) => {
        await loginViaUi(page);
        if (isMobile(page)) {
            await page.locator('#mobile-admin-nav').getByRole('button', { name: 'Altro' }).click();
            await page.locator('#mobile-admin-more').getByRole('button', { name: 'Statistiche sito', exact: true }).click();
        } else {
            await page.getByRole('button', { name: 'Statistiche del sito' }).click();
        }
        const modal = page.locator('#site-stats-modal');
        await expect(modal).toBeVisible();
        await expect(modal.getByText('Da dove arrivano')).toBeVisible();
        await expect(page.locator('#site-stats-content')).toContainText('Google');
        await expect(page.locator('#site-stats-content')).toContainText('Carate Brianza');
        await expect(page.locator('#site-stats-chart > div')).toHaveCount(30);
        await modal.getByRole('button', { name: '7 giorni' }).click();
        await expect(page.locator('#site-stats-chart > div')).toHaveCount(7);
        const results = await new AxeBuilder({ page }).include('#site-stats-modal').withTags(['wcag2a', 'wcag2aa']).analyze();
        expect(results.violations.filter(v => ['critical', 'serious'].includes(v.impact)).map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`)).toEqual([]);
        await modal.getByRole('button', { name: 'Chiudi' }).click();
        await expect(modal).toBeHidden();
    });
});
