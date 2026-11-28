import { describe, it, expect, afterEach } from 'vitest';
import { bootApp, SHARED } from '../support/jsdom-app.js';
import { seedDocs } from '../fixtures/seed.js';
import { readIndexHtml } from '../support/app-source.js';
import { SOURCE_LABELS, EVENT_LABELS, ITALIAN_CITY_NAMES } from '../../api/_statistiche-core.js';

/** Statistiche del sito nell'area riservata: lettura dei totali giornalieri scritti da api/statistiche.js. */
let app;
afterEach(() => app?.close());

function romeKey(offsetDays = 0) {
    const d = new Date(Date.now() + offsetDays * 86400000);
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d).map(x => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
}
const statsDoc = (date, data) => ({ [`${SHARED}/site_stats/${date}`]: { date, ...data } });

const SAMPLE = {
    ...statsDoc(romeKey(0), {
        visits: 3, views: 5, sources: { google: 2, diretto: 1 }, devices: { telefono: 2, computer: 1 },
        places: { 'Carate Brianza': 2, Seregno: 1 }, hours: { '09': 2, '20': 1 },
        events: { richiesta_appuntamento: 1, faq: 2, instagram: 1 }, faq: { 'Quando non si esegue': 2 }, centers: { 'Centro Polisalute': 1 }
    }),
    ...statsDoc(romeKey(-1), { visits: 4, views: 6, sources: { google: 1, instagram: 3 }, devices: { telefono: 4 }, places: { 'Carate Brianza': 4 } }),
    ...statsDoc(romeKey(-40), { visits: 10, views: 12, sources: { miodottore: 10 }, devices: { computer: 10 } })
};

async function openStats(docs = SAMPLE) {
    app = await bootApp({ docs: seedDocs({ extra: docs }) });
    await app.login();
    app.window.openSiteStatsModal();
    await app.waitFor(() => !app.text('site-stats-content').includes('Caricamento'), 'statistiche caricate');
    return app;
}

describe('area riservata: statistiche del sito', () => {
    it('somma i totali del periodo (30 giorni di default) e mostra provenienza, dispositivi, comuni e azioni', async () => {
        await openStats();
        expect(app.byId('site-stats-modal').classList.contains('hidden')).toBe(false);
        const text = app.text('site-stats-content');
        expect(text).toMatch(/Visite\s*7(?!\d)/);
        expect(text).toMatch(/Pagine viste\s*11(?!\d)/);
        expect(text).toMatch(/Oggi\s*3(?!\d)/);
        for (const label of ['Google', 'Instagram', 'Telefono', 'Carate Brianza', 'Seregno', 'Richieste di appuntamento inviate', 'Quando non si esegue', 'Centro Polisalute', 'Mattina (6-12)']) {
            expect(text, label).toContain(label);
        }
        expect(text).not.toContain('MioDottore'); // 40 giorni fa: fuori dal periodo
        expect(app.$$('#site-stats-chart > div')).toHaveLength(30);
        expect(app.$('[data-site-stats-days="30"]').getAttribute('aria-pressed')).toBe('true');
    });

    it('il periodo di 90 giorni include i giorni più vecchi; 7 giorni mostra 7 barre', async () => {
        await openStats();
        app.window.setSiteStatsPeriod(90);
        expect(app.text('site-stats-content')).toMatch(/Visite\s*17(?!\d)/);
        expect(app.text('site-stats-content')).toContain('MioDottore');
        app.window.setSiteStatsPeriod(7);
        expect(app.$$('#site-stats-chart > div')).toHaveLength(7);
        expect(app.text('site-stats-summary')).toContain('Ultimi 7 giorni');
    });

    it('il grafico ha barre con altezza e colore propri (la più alta è il giorno con più visite)', async () => {
        await openStats();
        app.window.setSiteStatsPeriod(7);
        const bars = app.$$('#site-stats-chart > div');
        const today = bars.at(-1);
        const yesterday = bars.at(-2);
        expect(yesterday.getAttribute('data-visits')).toBe('4');
        expect(yesterday.style.height).toBe('112px');
        expect(today.style.height).toBe(`${Math.round(3 / 4 * 112)}px`);
        expect(today.style.backgroundColor).not.toBe('');
        expect(bars[0].style.height).toBe('2px');
        expect(app.$('#site-stats-chart').getAttribute('aria-label')).toMatch(/: .* 4, .* 3$/);
    });

    it('i nomi inglesi delle città (es. Milan) diventano italiani e si sommano a quelli già italiani', async () => {
        await openStats(statsDoc(romeKey(0), { visits: 5, views: 5, places: { Milan: 3, Milano: 2 } }));
        expect(app.text('site-stats-content')).toMatch(/Milano\s*5(?!\d)/);
        expect(app.text('site-stats-content')).not.toContain('Milan ');
    });

    it('senza dati spiega che i conteggi partono dall\'attivazione', async () => {
        await openStats({});
        expect(app.text('site-stats-content')).toContain('Nessuna visita registrata');
    });

    it('i testi arrivati dal sito (comuni, domande) sono mostrati come testo, mai come HTML', async () => {
        await openStats(statsDoc(romeKey(0), { visits: 1, views: 1, places: { '<img src=x onerror=alert(1)>': 1 } }));
        expect(app.$('#site-stats-content img')).toBeNull();
        expect(app.text('site-stats-content')).toContain('<img src=x onerror=alert(1)>');
    });

    it('all\'accesso il dispositivo di Silvia e Aldo viene escluso dalle statistiche; si può riattivare', async () => {
        await openStats();
        expect(app.window.localStorage.getItem('statisticheIgnoraDispositivo')).toBe('1');
        expect(app.byId('site-stats-ignore').checked).toBe(true);
        expect(app.byId('site-stats-ignore').getAttribute('onchange')).toBe('setSiteStatsIgnore(this.checked)');
        app.window.setSiteStatsIgnore(false);
        expect(app.window.localStorage.getItem('statisticheIgnoraDispositivo')).toBeNull();
        app.window.setSiteStatsPeriod(7);
        expect(app.byId('site-stats-ignore').checked).toBe(false);
    });

    it('si chiude e rimette a posto lo stato delle finestre', async () => {
        await openStats();
        const openBefore = app.$$('[id$="-modal"]').filter(m => !m.classList.contains('hidden')).map(m => m.id);
        expect(openBefore).toContain('site-stats-modal');
        app.window.closeSiteStatsModal();
        expect(app.byId('site-stats-modal').classList.contains('hidden')).toBe(true);
        const openAfter = app.$$('[id$="-modal"]').filter(m => !m.classList.contains('hidden')).map(m => m.id);
        expect(openAfter).toEqual(openBefore.filter(id => id !== 'site-stats-modal'));
        expect(app.document.body.classList.contains('modal-open')).toBe(openAfter.length > 0);
    });

    it('i pulsanti per aprirla ci sono sia sul computer sia nel menu "Altro" del telefono', async () => {
        app = await bootApp();
        expect(app.$$('[onclick="openSiteStatsModal()"]')).toHaveLength(1);
        expect(app.$$('[onclick="mobileOpenAdmin(openSiteStatsModal)"]')).toHaveLength(1);
    });
});

describe('etichette delle statistiche', () => {
    const html = readIndexHtml();
    const keysOf = (name) => Object.keys(Object.fromEntries([...html.match(new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n {8}\\};`))[1].matchAll(/(\w+):\s*['"]/g)].map(m => [m[1], 1])));

    it('i nomi italiani delle città coincidono tra server e area riservata', () => {
        const block = html.match(/const SITE_STATS_CITY_NAMES = (\{[^}]*\});/)[1];
        expect(JSON.parse(block.replace(/(\w+):/g, '"$1":').replace(/'/g, '"'))).toEqual(ITALIAN_CITY_NAMES);
    });

    it('ogni provenienza e azione contata dal server ha un\'etichetta nell\'area riservata', () => {
        expect(keysOf('SITE_STATS_SOURCES').sort()).toEqual(Object.keys(SOURCE_LABELS).sort());
        expect(keysOf('SITE_STATS_EVENTS').sort()).toEqual(Object.keys(EVENT_LABELS).sort());
    });

    it('la pagina pubblica marca le azioni da contare', () => {
        for (const name of ['instagram', 'email', 'telefono', 'maps', 'centro_sito', 'centro_prenota']) expect(html, name).toContain(`data-stat="${name}"`);
        expect(html).toContain("new CustomEvent('statistiche:evento', { detail: 'richiesta_appuntamento' })");
        expect(html).toContain('<script src="/assets/js/statistiche.js" defer></script>');
    });
});
