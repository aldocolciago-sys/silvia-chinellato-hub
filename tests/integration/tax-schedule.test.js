import { describe, it, expect, afterEach } from 'vitest';
import { bootApp, SHARED } from '../support/jsdom-app.js';
import { seedDocs, studioEvent } from '../fixtures/seed.js';

let app;
afterEach(() => app?.close());

function fixClock(now) {
    return (w) => {
        const offset = now - Date.now();
        const RealDate = w.Date;
        class ShiftedDate extends RealDate {
            constructor(...args) { if (args.length === 0) super(RealDate.now() + offset); else super(...args); }
            static now() { return RealDate.now() + offset; }
        }
        w.Date = ShiftedDate;
    };
}
const nbsp = (s) => s.replace(/[  ]/g, ' ');
const PROFILE = `${SHARED}/tax_profile/default`;
// fatturato 2029: 30.000 € (tre compensi da 10.000 €)
const events2029 = [1, 2, 3].map(i => studioEvent({ id: `e${i}`, title: 'Seduta', start: `2029-0${i}-10T09:00:00`, end: `2029-0${i}-10T10:00:00`, extendedProps: { fee: 10000 } }));

async function loggedIn({ now = new Date(2030, 5, 20, 10, 0).getTime(), profile = { profitabilityCoefficient: 78, substituteTaxRate: 5, inpsRate: 26.07, advanceRate: 100, updatedAt: 'x' }, events = events2029 } = {}) {
    app = await bootApp({ docs: seedDocs({ events, extra: profile ? { [PROFILE]: profile } : {} }), beforeScript: fixClock(now) });
    await app.login();
    app.window.closeSyncReportModal();
    return app;
}

describe('scadenziario fiscale', () => {
    it('mostra le scadenze dell\'anno nella dashboard compensi', async () => {
        await loggedIn();
        app.window.openBusinessDashboard();
        expect(app.text('tax-schedule-title')).toBe('Scadenze fiscali 2030');
        const groups = app.$$('#tax-schedule [data-tax-deadline]');
        expect(groups.map(g => g.dataset.taxDeadline)).toEqual(['2030-07-01', '2030-12-02']); // 30/6 e 30/11 cadono nel fine settimana
        const june = nbsp(groups[0].textContent.replace(/\s+/g, ' '));
        expect(june).toContain('lunedì 1 luglio 2030');
        expect(june).toContain('Saldo imposta sostitutiva 2029');
        expect(june).toContain('1° acconto contributi 2030 (40%)');
        expect(app.text('tax-schedule')).toContain('non si conoscono gli acconti già versati');
    });

    it('promemoria nell\'area riservata 15 giorni prima, che si può nascondere', async () => {
        await loggedIn();
        expect(app.isHidden('tax-deadline-banner')).toBe(false);
        expect(nbsp(app.text('tax-deadline-banner-text'))).toMatch(/^📅 Scadenza fiscale tra 11 giorni \(1 luglio\): circa [\d.,]+ € da versare \(stima da verificare con il commercialista\)\.$/);
        app.window.dismissTaxDeadlineBanner();
        expect(app.isHidden('tax-deadline-banner')).toBe(true);
        app.window.updateTaxDeadlineBanner();
        expect(app.isHidden('tax-deadline-banner')).toBe(true);
    });

    it('nessun promemoria lontano dalle scadenze o senza profilo fiscale', async () => {
        await loggedIn({ now: new Date(2030, 3, 10, 10).getTime() });
        expect(app.isHidden('tax-deadline-banner')).toBe(true);
        app.close();
        await loggedIn({ profile: null });
        expect(app.isHidden('tax-deadline-banner')).toBe(true);
    });

    it('"Dettagli" apre la dashboard sullo scadenziario', async () => {
        await loggedIn();
        app.window.openTaxSchedule();
        expect(app.isHidden('business-dashboard-modal')).toBe(false);
        expect(app.byId('business-year').value).toBe('2030');
    });

    it('cassa con date personalizzate: salvataggio e scadenze', async () => {
        await loggedIn();
        app.window.openBusinessDashboard();
        expect(app.isHidden('tax-custom-deadlines')).toBe(true);
        app.setValue('tax-pension-fund', 'custom');
        app.window.onPensionFundChange();
        expect(app.isHidden('tax-custom-deadlines')).toBe(false);
        app.setValue('tax-custom-0-label', 'Saldo ENPAPI');
        app.setValue('tax-custom-0-day', '31/02');
        app.setValue('tax-custom-0-percent', '100');
        await app.submit('tax-profile-form');
        expect(app.toast()).toBe('Scadenza 1: scrivi la data come gg/mm (es. 30/09).');
        app.setValue('tax-custom-0-day', '30/09');
        await app.submit('tax-profile-form');
        expect(app.toast()).toBe('Profilo fiscale salvato.');
        expect(app.mock.get(PROFILE)).toMatchObject({ pensionFund: 'custom', customDeadlines: [{ label: 'Saldo ENPAPI', day: '30/09', percent: 100 }] });
        const groups = app.$$('#tax-schedule [data-tax-deadline]').map(g => g.dataset.taxDeadline);
        expect(groups).toEqual(['2030-07-01', '2030-09-30', '2030-12-02']);
        expect(app.text('tax-schedule')).toContain('Saldo ENPAPI');
        expect(app.text('tax-schedule')).not.toContain('Gestione separata');
    });

    it('senza fatturato dell\'anno precedente chiede di inserirlo', async () => {
        await loggedIn({ events: [] });
        app.window.openBusinessDashboard();
        expect(app.text('tax-schedule')).toContain('Nessun fatturato registrato per il 2029');
        app.setValue('tax-previous-revenue', '30000');
        app.window.renderTaxSimulator();
        expect(app.$$('#tax-schedule [data-tax-deadline]').length).toBe(2);
    });
});
