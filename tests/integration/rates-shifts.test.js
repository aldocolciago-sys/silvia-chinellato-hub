import { describe, it, expect, afterEach, vi } from 'vitest';
import { bootApp, SHARED } from '../support/jsdom-app.js';
import { seedDocs, center, studioEvent } from '../fixtures/seed.js';
import { vcalendar, vevent } from '../fixtures/ical.js';

let app;
afterEach(() => app?.close());

const nbsp = (s) => s.replace(/ /g, ' ');
const ICAL = 'https://calendari.example.com/cms.ics';
const cms = center({ id: 'cms', name: 'CMS - Carate Brianza', service: 'Idrocolonterapia', icalUrl: ICAL, rateIdrocolonterapia: 40 });
const sport = center({ id: 'sport', name: 'Medicina dello Sport', service: 'Turni', isNonClinicalCalendar: true, isShiftCalendar: true, hourlyRate: 25, showPublic: false, includeInFinance: true });
const personal = center({ id: 'casa', name: 'Agenda personale', isNonClinicalCalendar: true, showPublic: false, includeInFinance: false });

function icsFetch(getIcs) {
    return vi.fn(async () => new Response(JSON.stringify({ icsContent: getIcs() }), { headers: { 'content-type': 'application/json' } }));
}

async function loggedIn({ ics = vcalendar([]), centers = [cms, sport, personal], ...data } = {}) {
    let current = ics;
    app = await bootApp({ docs: seedDocs({ centers, ...data }), fetch: icsFetch(() => current) });
    await app.login();
    app.window.closeSyncReportModal();
    return { setIcs: (v) => { current = v; } };
}

describe('sincronizzazione: i dati inseriti a mano non vengono persi', () => {
    // Regressione (difetto corretto): a ogni sincronizzazione l'evento importato veniva riscritto da zero,
    // cancellando compenso, stato del pagamento e note inseriti a mano.
    it('conserva compenso, pagamento e nota dopo una nuova sincronizzazione', async () => {
        const calendar = vcalendar([vevent({ uid: 'a', summary: 'Marco Colombo', start: '20300115T090000Z', end: '20300115T100000Z' })]);
        await loggedIn({ ics: calendar });
        const saved = app.mock.get(`${SHARED}/studio_events/ical_cms_a`);
        app.mock.seed({ [`${SHARED}/studio_events/ical_cms_a`]: { ...saved, extendedProps: { ...saved.extendedProps, fee: 55, paymentStatus: 'unpaid', paymentMethod: 'card', clinicalNote: 'Seduta tranquilla' } } });
        await app.flush();
        await app.window.triggerIcalSync();
        await app.flush();
        expect(app.mock.get(`${SHARED}/studio_events/ical_cms_a`).extendedProps).toMatchObject({ fee: 55, paymentStatus: 'unpaid', paymentMethod: 'card', clinicalNote: 'Seduta tranquilla', centerId: 'cms' });
    });

    it('compila il compenso dei nuovi appuntamenti importati con la tariffa della sede', async () => {
        await loggedIn({ ics: vcalendar([vevent({ uid: 'b', summary: 'Nuovo paziente', start: '20300116T090000Z' })]) });
        expect(app.mock.get(`${SHARED}/studio_events/ical_cms_b`).extendedProps.fee).toBe(40);
    });
});

describe('compenso automatico nel modulo appuntamento', () => {
    it('propone la tariffa della sede scelta e la aggiorna se cambia sede', async () => {
        await loggedIn({ extra: { [`${SHARED}/settings/finance`]: { privateRates: { osteopatia: 60 } } } });
        app.window.openStudioModal();
        app.setValue('studio-title', 'Osteopatia - Anna');
        app.window.onStudioCenterChange();
        expect(app.byId('studio-fee').value).toBe('60');
        expect(app.isHidden('studio-fee-hint')).toBe(false);
        app.setValue('studio-center-select', 'cms');
        app.window.onStudioCenterChange();
        expect(app.byId('studio-fee').value).toBe('40');
    });

    it('non sovrascrive un compenso inserito a mano', async () => {
        await loggedIn();
        app.window.openStudioModal();
        app.setValue('studio-fee', '75');
        app.byId('studio-fee').dataset.auto = '';
        app.setValue('studio-center-select', 'cms');
        app.window.onStudioCenterChange();
        expect(app.byId('studio-fee').value).toBe('75');
    });

    it('mostra le sedi a turni nella scelta della sede', async () => {
        await loggedIn();
        app.window.openStudioModal();
        const labels = [...app.byId('studio-center-select').options].map(o => o.textContent);
        expect(labels).toContain('Medicina dello Sport (Turni)');
        expect(labels).not.toContain('Agenda personale');
    });
});

describe('turni retribuiti', () => {
    it('un turno salvato riceve compenso = durata × tariffa, senza dati clinici', async () => {
        await loggedIn();
        app.window.openStudioModal();
        app.setValue('studio-center-select', 'sport');
        app.window.onStudioCenterChange();
        expect(app.isHidden('studio-patient-section')).toBe(true);
        expect(app.isHidden('studio-finance-section')).toBe(false);
        app.setValue('studio-title', 'Turno ambulatorio');
        app.setValue('studio-date', '2030-03-04');
        app.setValue('studio-time-start', '08:00');
        app.window.onStartTimeChange();
        app.setValue('studio-time-end', '13:00');
        app.window.suggestStudioFee();
        expect(app.byId('studio-fee').value).toBe('125');
        await app.submit('studio-event-form');
        const saved = app.mock.list(`${SHARED}/studio_events`)[0];
        expect(saved.extendedProps).toMatchObject({ centerId: 'sport', fee: 125, patientId: null, isNonClinical: true, paymentStatus: 'paid' });
    });

    it('la dashboard mostra ore e compensi dei turni e li include nel fatturato', async () => {
        await loggedIn({
            events: [
                studioEvent({ id: 't1', title: 'Turno', start: '2030-03-04T08:00:00', end: '2030-03-04T13:00:00', extendedProps: { centerId: 'sport', isNonClinical: true, fee: 125 } }),
                studioEvent({ id: 't2', title: 'Turno', start: '2030-03-11T08:00:00', end: '2030-03-11T11:30:00', extendedProps: { centerId: 'sport', isNonClinical: true, fee: 87.5 } }),
                studioEvent({ id: 'p1', title: 'Dentista', start: '2030-03-05T08:00:00', end: '2030-03-05T09:00:00', extendedProps: { centerId: 'casa', isNonClinical: true, fee: 0 } })
            ]
        });
        app.byId('business-month').value = '2030-03';
        app.window.openBusinessDashboard();
        expect(app.isHidden('business-shifts-section')).toBe(false);
        const row = [...app.$$('#business-shifts tbody td')].map(td => nbsp(td.textContent.trim()));
        expect(row).toEqual(['Medicina dello Sport25,00 €/h', '8 h 30 min', '212,50 €', '8 h 30 min', '212,50 €']);
        const fatturato = app.$$('#business-kpis > div').map(d => nbsp(d.textContent))[1];
        expect(fatturato).toContain('212,50 €');
        expect(app.text('business-missing-fee-count')).toBe('0 da completare'); // il calendario personale resta fuori
    });

    it('le sedi a turni restano nei compensi anche dopo il controllo delle impostazioni', async () => {
        await loggedIn({ centers: [{ id: 'sport', name: 'Medicina dello Sport', service: 'Turni', isNonClinicalCalendar: true, isShiftCalendar: true, hourlyRate: 25, showPublic: true }] });
        expect(app.mock.get(`${SHARED}/centers_list/sport`)).toMatchObject({ includeInFinance: true, showPublic: false });
    });
});

describe('gestione tariffe', () => {
    it('salva tariffe della sede e opzione turni dal modulo poliambulatori', async () => {
        await loggedIn({ centers: [] });
        app.window.openCentersModal();
        app.setValue('new-center-name', 'Polisalute');
        app.setValue('new-center-service', 'Idrocolonterapia');
        app.setValue('new-center-rate-idrocolonterapia', '42.5');
        await app.submit('center-form');
        expect(app.state.centers.find(c => c.name === 'Polisalute')).toMatchObject({ rateIdrocolonterapia: 42.5, rateOsteopatia: 0, isShiftCalendar: false });
        expect(app.text('centers-management-list')).toContain('Idro 42,50 €');

        app.setValue('new-center-name', 'Medicina dello Sport');
        app.setValue('new-center-service', 'Turni');
        app.byId('new-center-non-clinical').checked = true;
        app.window.applyNonClinicalCenterFormState();
        expect(app.isHidden('center-rates-block')).toBe(true);
        expect(app.isHidden('center-shift-block')).toBe(false);
        app.byId('new-center-shift').checked = true;
        app.window.applyNonClinicalCenterFormState();
        expect(app.isHidden('center-hourly-rate-row')).toBe(false);
        app.setValue('new-center-hourly-rate', '25');
        await app.submit('center-form');
        const shiftCenter = app.state.centers.find(c => c.name === 'Medicina dello Sport');
        expect(shiftCenter).toMatchObject({ isNonClinicalCalendar: true, isShiftCalendar: true, hourlyRate: 25, includeInFinance: true, showPublic: false });

        app.window.editCenter(shiftCenter.id);
        expect(app.byId('new-center-shift').checked).toBe(true);
        expect(app.byId('new-center-hourly-rate').value).toBe('25');
    });

    it('salva le tariffe dello studio privato', async () => {
        await loggedIn();
        app.window.openCentersModal();
        app.setValue('private-rate-osteopatia', '60');
        await app.submit('private-rates-form');
        expect(app.toast()).toBe('Tariffe dello studio salvate.');
        expect(app.mock.get(`${SHARED}/settings/finance`).privateRates).toEqual({ osteopatia: 60, idrocolonterapia: 0 });
    });

    it('compila i compensi mancanti con le tariffe senza toccare quelli esistenti', async () => {
        await loggedIn({
            events: [
                studioEvent({ id: 'a', title: 'Paziente A', start: '2030-03-02T09:00:00', end: '2030-03-02T10:00:00', extendedProps: { centerId: 'cms', fee: 0 } }),
                studioEvent({ id: 'b', title: 'Paziente B', start: '2030-03-03T09:00:00', end: '2030-03-03T10:00:00', extendedProps: { centerId: 'cms', fee: 70 } }),
                studioEvent({ id: 'c', title: 'Senza tariffa', start: '2030-03-04T09:00:00', end: '2030-03-04T10:00:00', extendedProps: { fee: 0 } })
            ]
        });
        app.byId('business-month').value = '2030-03';
        app.window.openBusinessDashboard();
        expect(app.isHidden('fill-missing-fees-btn')).toBe(false);
        expect(app.text('fill-missing-fees-btn')).toBe('Compila 1 con le tariffe');
        app.window.fillMissingFees();
        expect(app.text('confirm-text')).toContain('1 appuntamenti del 2030');
        await app.confirm();
        expect(app.mock.get(`${SHARED}/studio_events/a`).extendedProps.fee).toBe(40);
        expect(app.mock.get(`${SHARED}/studio_events/b`).extendedProps.fee).toBe(70);
        expect(app.mock.get(`${SHARED}/studio_events/c`).extendedProps.fee).toBe(0);
        expect(app.isHidden('fill-missing-fees-btn')).toBe(true);
    });

    it('il backup include le tariffe dello studio', async () => {
        await loggedIn({ extra: { [`${SHARED}/settings/finance`]: { privateRates: { osteopatia: 60 } } } });
        expect(app.fn.buildBackupPayload().data.financeSettings).toEqual({ privateRates: { osteopatia: 60 } });
    });
});
