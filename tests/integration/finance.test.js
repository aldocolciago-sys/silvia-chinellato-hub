import { describe, it, expect, afterEach } from 'vitest';
import { bootApp, SHARED } from '../support/jsdom-app.js';
import { seedDocs, center, patient, studioEvent } from '../fixtures/seed.js';

let app;
afterEach(() => app?.close());

const nbsp = (s) => s.replace(/ /g, ' ');
const kpis = (id) => app.$$(`#${id} > div`).map(d => [d.querySelector('p').textContent, nbsp(d.querySelector('strong').textContent)]);

const centers = [
    center({ id: 'c1', name: 'Centro A' }),
    center({ id: 'cx', name: 'Sede esclusa', includeInFinance: false })
];
const events = [
    studioEvent({ id: 'e1', title: 'Pagata', start: '2030-03-05T09:00:00', extendedProps: { centerId: 'c1', centerName: 'Centro A', fee: 100, paymentStatus: 'paid', patientId: 'p1' } }),
    studioEvent({ id: 'e2', title: 'Da incassare', start: '2030-03-06T09:00:00', extendedProps: { fee: 50, paymentStatus: 'unpaid' } }),
    studioEvent({ id: 'e3', title: 'Senza compenso', start: '2030-03-07T09:00:00', extendedProps: { fee: 0, patientId: 'p1' } }),
    studioEvent({ id: 'e4', title: 'Annullata', start: '2030-03-08T09:00:00', extendedProps: { fee: 999, paymentStatus: 'cancelled' } }),
    studioEvent({ id: 'e5', title: 'Esclusa', start: '2030-03-09T09:00:00', extendedProps: { centerId: 'cx', fee: 500 } }),
    studioEvent({ id: 'e6', title: 'Luglio', start: '2030-07-01T09:00:00', extendedProps: { fee: 200 } }),
    studioEvent({ id: 'e7', title: 'Anno prima', start: '2029-03-01T09:00:00', extendedProps: { fee: 300 } })
];
const manualRevenues = [
    { id: 'r1', date: '2030-03-10', amount: 1000, category: 'Fatturato storico', description: 'Gennaio-Febbraio' },
    { id: 'r2', date: '2029-12-10', amount: 500, category: 'Altro', description: 'Anno precedente' }
];

async function openDashboard(extra = {}) {
    app = await bootApp({ docs: seedDocs({ centers, events, manualRevenues, patients: [patient({ id: 'p1', name: 'Mario Rossi' })], ...extra }) });
    await app.login();
    app.window.closeSyncReportModal();
    app.byId('business-month').value = '2030-03';
    app.window.openBusinessDashboard();
    return app;
}

describe('dashboard finanziaria', () => {
    it('calcola i KPI del mese escludendo annullati e sedi escluse', async () => {
        await openDashboard();
        expect(app.byId('business-year').value).toBe('2030');
        expect(kpis('business-kpis')).toEqual([
            ['Appuntamenti', '3'],
            ['Fatturato totale', '1150,00 €'],
            ['Incassato / fatturato', '1100,00 €'],
            ['Da incassare', '50,00 €']
        ]);
    });

    it('raggruppa il mese per sede ordinando per totale', async () => {
        await openDashboard();
        const rows = app.$$('#business-by-center tbody tr').map(tr => [...tr.querySelectorAll('td')].map(td => nbsp(td.textContent)));
        expect(rows).toEqual([
            ['Studio Privato', '2', '0,00 €', '50,00 €', '50,00 €'],
            ['Centro A', '1', '100,00 €', '0,00 €', '100,00 €']
        ].sort((a, b) => parseFloat(b[4]) - parseFloat(a[4])));
    });

    it('calcola i KPI annuali includendo le entrate manuali dell’anno', async () => {
        await openDashboard();
        expect(kpis('business-year-kpis')).toEqual([
            ['Anno', '2030'],
            ['Appuntamenti', '4'],
            ['Da appuntamenti', '350,00 €'],
            ['Entrate manuali', '1000,00 €'],
            ['Fatturato totale', '1350,00 €']
        ]);
        expect(nbsp(app.text('manual-revenue-year-total'))).toBe("1000,00 € nell'anno 2030");
        expect(app.$$('#manual-revenue-list article').length).toBe(1);
    });

    it('cambiando mese aggiorna anche l’anno di riferimento', async () => {
        await openDashboard();
        app.setValue('business-month', '2029-03');
        app.window.syncBusinessYearFromMonth();
        app.window.renderBusinessDashboard();
        expect(app.byId('business-year').value).toBe('2029');
        expect(kpis('business-year-kpis')[4]).toEqual(['Fatturato totale', '800,00 €']);
    });

    it('mostra un messaggio se nel mese non ci sono compensi', async () => {
        await openDashboard();
        app.setValue('business-month', '2031-01');
        app.window.renderBusinessDashboard();
        expect(app.text('business-by-center')).toContain('Nessun compenso registrato nel mese.');
    });

    it('elenca gli appuntamenti senza compenso e permette di completarli tornando alla dashboard', async () => {
        await openDashboard();
        expect(app.text('business-missing-fee-count')).toBe('1 da completare');
        const item = app.$('#business-missing-fee-list button');
        expect(item.textContent).toContain('Senza compenso');
        expect(item.textContent).toContain('Mario Rossi');
        app.window.openFinanceEvent(encodeURIComponent('e3'));
        expect(app.isHidden('business-dashboard-modal')).toBe(true);
        expect(app.isHidden('studio-modal')).toBe(false);
        app.setValue('studio-fee', '80');
        await app.submit('studio-event-form');
        expect(app.isHidden('business-dashboard-modal')).toBe(false);
        expect(app.text('business-missing-fee-count')).toBe('0 da completare');
        expect(app.mock.get(`${SHARED}/studio_events/e3`).extendedProps.fee).toBe(80);
    });
});

describe('entrate manuali', () => {
    it('rifiuta importi nulli o negativi', async () => {
        await openDashboard();
        app.setValue('manual-revenue-amount', '0');
        await app.submit('manual-revenue-form');
        expect(app.toast()).toBe('Inserisci un importo maggiore di zero.');
        app.setValue('manual-revenue-amount', '-5');
        await app.submit('manual-revenue-form');
        expect(app.toast()).toBe('Inserisci un importo maggiore di zero.');
    });

    it('aggiunge, modifica ed elimina un’entrata manuale', async () => {
        await openDashboard();
        expect(app.byId('manual-revenue-date').value).toBe(new Date().toISOString().slice(0, 10));
        app.setValue('manual-revenue-date', '2030-03-20');
        app.setValue('manual-revenue-amount', '250.5');
        app.setValue('manual-revenue-description', '  Corso  ');
        await app.submit('manual-revenue-form');
        expect(app.toast()).toBe('Entrata manuale aggiunta.');
        const created = app.mock.list(`${SHARED}/manual_revenue`).find(r => r.description === 'Corso');
        expect(created).toMatchObject({ amount: 250.5, date: '2030-03-20', category: 'Fatturato storico' });
        expect(kpis('business-year-kpis')[3]).toEqual(['Entrate manuali', '1250,50 €']);

        app.window.editManualRevenue(encodeURIComponent(created.id));
        expect(app.text('manual-revenue-submit-label')).toBe('Aggiorna entrata');
        expect(app.isHidden('manual-revenue-cancel')).toBe(false);
        app.setValue('manual-revenue-amount', '300');
        await app.submit('manual-revenue-form');
        expect(app.toast()).toBe('Entrata manuale aggiornata.');
        const updated = app.mock.get(`${SHARED}/manual_revenue/${created.id}`);
        expect(updated.amount).toBe(300);
        expect(updated.createdAt).toBe(created.createdAt);

        app.window.confirmDeleteManualRevenue(encodeURIComponent(created.id));
        expect(app.text('confirm-text')).toContain('Corso');
        await app.confirm();
        expect(app.mock.has(`${SHARED}/manual_revenue/${created.id}`)).toBe(false);
        expect(app.toast()).toBe('Entrata manuale eliminata.');
    });

    it('segnala il fallimento del salvataggio', async () => {
        await openDashboard();
        app.setValue('manual-revenue-amount', '10');
        app.mock.failNext('setDoc', `${SHARED}/manual_revenue`);
        await app.submit('manual-revenue-form');
        expect(app.toast()).toBe('Errore: entrata manuale non salvata.');
    });
});

describe('profilo fiscale e simulatore', () => {
    it('precompila il modulo con i valori predefiniti del forfettario', async () => {
        await openDashboard();
        expect(app.byId('tax-profitability').value).toBe('78');
        expect(app.byId('tax-substitute-rate').value).toBe('15');
        expect(app.byId('tax-inps-rate').value).toBe('26.07');
        expect(app.byId('tax-advance-rate').value).toBe('100');
        expect(app.text('tax-profile-status')).toBe('Profilo da salvare');
    });

    it('calcola contributi, imposta, acconto e totale da accantonare', async () => {
        await openDashboard();
        app.window.renderTaxSimulator(10000);
        // 10.000 × 78% = 7.800 imponibile; INPS 26,07% = 2.033,46; imposta 15% su 5.766,54 = 864,98
        expect(kpis('tax-simulator-kpis')).toEqual([
            ['Fatturato 2030', '10.000,00 €'],
            ['Contributi 2030', '2033,46 €'],
            ['Imposta 2030', '864,98 €'],
            ['Acconto imposta 2031', '864,98 €'],
            ['Totale da accantonare', '3763,42 €']
        ]);
    });

    it('ricalcola con aliquota ridotta del 5% e acconto zero', async () => {
        await openDashboard();
        app.setValue('tax-substitute-rate', '5');
        app.setValue('tax-advance-rate', '0');
        app.window.renderTaxSimulator(10000);
        const values = Object.fromEntries(kpis('tax-simulator-kpis'));
        expect(values['Imposta 2030']).toBe('288,33 €');
        expect(values['Acconto imposta 2031']).toBe('0,00 €');
        expect(values['Totale da accantonare']).toBe('2321,79 €');
    });

    it('usa il fatturato dell’anno (appuntamenti + entrate manuali) quando non c’è override', async () => {
        await openDashboard();
        expect(kpis('tax-simulator-kpis')[0]).toEqual(['Fatturato 2030', '1350,00 €']);
    });

    it('salva il profilo fiscale su Firestore', async () => {
        await openDashboard();
        app.setValue('tax-previous-revenue', '42000');
        app.setValue('tax-profitability', '67');
        await app.submit('tax-profile-form');
        expect(app.toast()).toBe('Profilo fiscale salvato.');
        expect(app.mock.get(`${SHARED}/tax_profile/default`)).toMatchObject({ id: 'default', previousYearRevenue: 42000, profitabilityCoefficient: 67, substituteTaxRate: 15 });
        expect(app.text('tax-profile-status')).toBe('Profilo salvato');
    });

    it.each([['tax-profitability', '150'], ['tax-inps-rate', '-1'], ['tax-inps-rate', '101']])('rifiuta valori fuori intervallo (%s = %s)', async (field, value) => {
        await openDashboard();
        app.setValue(field, value);
        await app.submit('tax-profile-form');
        expect(app.toast()).toBe('Controlla le aliquote inserite.');
        expect(app.mock.has(`${SHARED}/tax_profile/default`)).toBe(false);
    });

    it('carica un profilo fiscale esistente', async () => {
        await openDashboard({ taxProfile: { previousYearRevenue: 30000, profitabilityCoefficient: 67, substituteTaxRate: 5, inpsRate: 24, advanceRate: 50, updatedAt: '2030-01-01T00:00:00Z' } });
        expect(app.byId('tax-previous-revenue').value).toBe('30000');
        expect(app.byId('tax-substitute-rate').value).toBe('5');
        expect(app.text('tax-profile-status')).toBe('Profilo salvato');
    });
});
