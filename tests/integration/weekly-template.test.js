import { describe, it, expect, afterEach } from 'vitest';
import { bootApp, SHARED } from '../support/jsdom-app.js';
import { seedDocs, center, studioEvent } from '../fixtures/seed.js';

let app;
afterEach(() => app?.close());

const centers = [
    center({ id: 'cms', name: 'CMS - Carate Brianza', color: '#4a8fa8' }),
    center({ id: 'sport', name: 'Medicina dello Sport', color: '#d97706', isNonClinicalCalendar: true, isShiftCalendar: true, hourlyRate: 25, showPublic: false, includeInFinance: true }),
    center({ id: 'casa', name: 'Agenda personale', isNonClinicalCalendar: true, showPublic: false, includeInFinance: false })
];
const AGENDA = `${SHARED}/settings/agenda`;
const template = { travelMinutes: 45, weeklyTemplate: [{ weekday: 2, centerId: 'sport', from: '09:00', to: '13:00' }, { weekday: 1, centerId: 'cms', from: '14:00', to: '19:00' }] };

async function loggedIn({ agenda, events = [] } = {}) {
    app = await bootApp({ docs: seedDocs({ centers, events, extra: agenda ? { [AGENDA]: agenda } : {} }) });
    await app.login();
    app.window.closeSyncReportModal();
    return app;
}

function renderRange(start, end) {
    let rendered = [];
    app.calendar.options.events({ start, end }, events => { rendered = events; });
    return rendered;
}

describe('settimana tipo', () => {
    it('si imposta dalla finestra dedicata e viene salvata', async () => {
        await loggedIn();
        app.window.openAgendaSettingsModal();
        expect(app.isHidden('agenda-settings-modal')).toBe(false);
        expect(app.byId('agenda-travel-minutes').value).toBe('45');
        expect(app.text('weekly-template-list')).toContain('Nessuna fascia');

        app.window.addTemplateSlot();
        app.setValue('slot-weekday-0', '2');
        app.setValue('slot-center-0', 'sport');
        app.setValue('slot-from-0', '09:00');
        app.setValue('slot-to-0', '13:00');
        app.window.addTemplateSlot();
        expect(app.byId('slot-weekday-1').value).toBe('3'); // propone il giorno dopo, stessa sede
        expect(app.byId('slot-center-1').value).toBe('sport');
        app.setValue('slot-weekday-1', '1');
        app.setValue('slot-center-1', 'studio');
        app.setValue('slot-from-1', '15:00');
        app.setValue('slot-to-1', '19:00');
        app.setValue('agenda-travel-minutes', '30');
        const locations = [...app.byId('slot-center-0').options].map(o => o.textContent);
        expect(locations).toEqual(['Studio privato', 'CMS - Carate Brianza', 'Medicina dello Sport']);

        await app.submit('agenda-settings-form');
        expect(app.toast()).toBe('Settimana tipo salvata.');
        expect(app.isHidden('agenda-settings-modal')).toBe(true);
        expect(app.mock.get(AGENDA)).toMatchObject({
            travelMinutes: 30,
            weeklyTemplate: [{ weekday: 1, centerId: 'studio', from: '15:00', to: '19:00' }, { weekday: 2, centerId: 'sport', from: '09:00', to: '13:00' }]
        });
    });

    it('rifiuta fasce con orari invertiti', async () => {
        await loggedIn();
        app.window.openAgendaSettingsModal();
        app.window.addTemplateSlot();
        app.setValue('slot-from-0', '13:00');
        app.setValue('slot-to-0', '09:00');
        await app.submit('agenda-settings-form');
        expect(app.toast()).toBe("Fascia 1: l'ora di fine deve essere dopo l'inizio.");
        expect(app.mock.get(AGENDA)).toBeUndefined();
    });

    it('rimuove una fascia', async () => {
        await loggedIn({ agenda: template });
        app.window.openAgendaSettingsModal();
        expect(app.$$('#weekly-template-list [data-slot-index]').length).toBe(2);
        app.window.removeTemplateSlot(0);
        await app.submit('agenda-settings-form');
        expect(app.mock.get(AGENDA).weeklyTemplate).toEqual([{ weekday: 1, centerId: 'cms', from: '14:00', to: '19:00' }]);
    });

    it('segnala un errore di salvataggio', async () => {
        await loggedIn();
        app.window.openAgendaSettingsModal();
        app.mock.failNext('setDoc');
        await app.submit('agenda-settings-form');
        expect(app.toast()).toBe('Errore: settimana tipo non salvata.');
        expect(app.isHidden('agenda-settings-modal')).toBe(false);
    });

    it('mostra le fasce come sfondo nel calendario', async () => {
        await loggedIn({ agenda: template });
        const bg = renderRange(new Date(2030, 2, 4), new Date(2030, 2, 11)).filter(e => e.display === 'background');
        expect(bg.map(e => [e.start, e.title])).toEqual([
            ['2030-03-04T14:00:00', 'CMS - Carate Brianza'],
            ['2030-03-05T09:00:00', 'Medicina dello Sport']
        ]);
    });

    it('avvisa nel modulo appuntamento se la sede non è quella della settimana tipo', async () => {
        await loggedIn({ agenda: template });
        app.window.openStudioModal();
        app.setValue('studio-date', '2030-03-05');
        app.setValue('studio-time-start', '10:00');
        app.window.onStartTimeChange();
        expect(app.isHidden('studio-template-hint')).toBe(false);
        expect(app.text('studio-template-hint')).toBe('🗓 Di solito il martedì dalle 09:00 alle 13:00 sei presso Medicina dello Sport: controlla la sede.');
        app.setValue('studio-center-select', 'sport');
        app.window.onStudioCenterChange();
        expect(app.isHidden('studio-template-hint')).toBe(true);
    });

    it('il backup include la settimana tipo', async () => {
        await loggedIn({ agenda: template });
        expect(app.fn.buildBackupPayload().data.agendaSettings).toEqual(template);
    });
});

describe('tempi di spostamento', () => {
    const tight = [
        studioEvent({ id: 'a', title: 'Paziente CMS', start: '2030-03-04T09:00:00', end: '2030-03-04T10:00:00', extendedProps: { centerId: 'cms' } }),
        studioEvent({ id: 'b', title: 'Paziente studio', start: '2030-03-04T10:20:00', end: '2030-03-04T11:20:00' })
    ];

    it('segnala gli spostamenti stretti con banner arancione e bordo nel calendario', async () => {
        await loggedIn({ events: tight });
        expect(app.isHidden('calendar-transfer-banner')).toBe(false);
        expect(app.text('transfer-banner-text')).toBe('⏱ 1 spostamento stretto: meno di 45 minuti tra due sedi diverse.');
        expect(app.isHidden('calendar-conflict-banner')).toBe(true);
        const byId = Object.fromEntries(app.calendar.renderedEvents.map(e => [e.id, e]));
        expect(byId.b.title).toBe('⏱ [SPOSTAMENTO] Paziente studio');
        expect(byId.b.borderColor).toBe('#ea580c');
        expect(byId.a.title).toBe('Paziente CMS');
    });

    it('Verifica porta al giorno dello spostamento', async () => {
        await loggedIn({ events: tight });
        app.window.scrollToTightTransfer();
        expect(app.calendar.calls).toContainEqual(['gotoDate', new Date('2030-03-04T10:20:00').toISOString()]);
        expect(app.calendar.view).toBe('timeGridDay');
    });

    it('rispetta il tempo impostato (0 = disattivato)', async () => {
        await loggedIn({ events: tight, agenda: { travelMinutes: 15, weeklyTemplate: [] } });
        expect(app.isHidden('calendar-transfer-banner')).toBe(true);
        app.window.openAgendaSettingsModal();
        app.setValue('agenda-travel-minutes', '60');
        await app.submit('agenda-settings-form');
        expect(app.text('transfer-banner-text')).toBe('⏱ 1 spostamento stretto: meno di 60 minuti tra due sedi diverse.');
        app.window.openAgendaSettingsModal();
        app.setValue('agenda-travel-minutes', '0');
        await app.submit('agenda-settings-form');
        expect(app.isHidden('calendar-transfer-banner')).toBe(true);
    });

    it('i clic sulle fasce di sfondo non aprono il modulo', async () => {
        await loggedIn({ agenda: template });
        app.calendar.options.eventClick({ event: { id: 'template_2030-03-05_0', display: 'background', extendedProps: { isTemplate: true }, title: 'Medicina dello Sport' } });
        expect(app.isHidden('studio-modal')).toBe(true);
    });
});
