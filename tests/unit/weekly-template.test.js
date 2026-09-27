import { describe, it, expect } from 'vitest';
import { loadFunctions } from '../support/app-source.js';

const centers = [
    { id: 'cms', name: 'CMS - Carate Brianza', color: '#4a8fa8' },
    { id: 'sport', name: 'Medicina dello Sport', color: '#d97706', isNonClinicalCalendar: true, isShiftCalendar: true, hourlyRate: 25 },
    { id: 'casa', name: 'Agenda personale', isNonClinicalCalendar: true }
];

function agendaFns(agendaSettings = null) {
    const appState = { centers, events: [], agendaSettings };
    return loadFunctions(
        ['timeToMinutes', 'isValidTemplateSlot', 'agendaSettings', 'findCenterById', 'templateLocationName', 'templateLocationColor',
            'eventLocationKey', 'localDayKey', 'findTightTransfers', 'templateBackgroundEvents', 'templateMismatch', 'templateMismatchMessage',
            'isShiftCenter', 'safeColor'],
        { appState },
        { consts: ['WEEKDAY_NAMES', 'DEFAULT_TRAVEL_MINUTES', 'PRIVATE_STUDIO_KEY'] }
    );
}

const ev = (id, centerId, start, end, extra = {}) => ({ id, title: id, start, end, extendedProps: { centerId, ...extra } });

describe('findTightTransfers', () => {
    const { findTightTransfers } = agendaFns();

    it('segnala due appuntamenti in sedi diverse con meno tempo del necessario', () => {
        const events = [
            ev('a', 'cms', '2030-03-04T09:00:00', '2030-03-04T10:00:00'),
            ev('b', null, '2030-03-04T10:30:00', '2030-03-04T11:30:00')
        ];
        expect(findTightTransfers(events, 45)).toEqual([{ from: events[0], to: events[1], gapMinutes: 30 }]);
    });

    it.each([
        ['esattamente il tempo minimo', '10:45', 0],
        ['un minuto in meno', '10:44', 1],
        ['subito dopo', '10:00', 1]
    ])('confine: %s', (_, time, count) => {
        const events = [ev('a', 'cms', '2030-03-04T09:00:00', '2030-03-04T10:00:00'), ev('b', 'sport', `2030-03-04T${time}:00`, '2030-03-04T13:00:00')];
        expect(findTightTransfers(events, 45)).toHaveLength(count);
    });

    it('ignora la stessa sede, i giorni diversi, le sovrapposizioni (sono conflitti) e gli annullati', () => {
        expect(findTightTransfers([ev('a', 'cms', '2030-03-04T09:00:00', '2030-03-04T10:00:00'), ev('b', 'cms', '2030-03-04T10:00:00', '2030-03-04T11:00:00')], 45)).toEqual([]);
        expect(findTightTransfers([ev('a', 'cms', '2030-03-04T23:00:00', '2030-03-04T23:30:00'), ev('b', 'sport', '2030-03-05T00:00:00', '2030-03-05T01:00:00')], 45)).toEqual([]);
        expect(findTightTransfers([ev('a', 'cms', '2030-03-04T09:00:00', '2030-03-04T10:30:00'), ev('b', 'sport', '2030-03-04T10:00:00', '2030-03-04T11:00:00')], 45)).toEqual([]);
        expect(findTightTransfers([ev('a', 'cms', '2030-03-04T09:00:00', '2030-03-04T10:00:00'), ev('b', 'sport', '2030-03-04T10:15:00', '2030-03-04T11:00:00', { paymentStatus: 'cancelled' })], 45)).toEqual([]);
    });

    it('i calendari personali non contano e non interrompono la sequenza', () => {
        const events = [
            ev('a', 'cms', '2030-03-04T09:00:00', '2030-03-04T10:00:00'),
            ev('pranzo', 'casa', '2030-03-04T10:05:00', '2030-03-04T10:10:00'),
            ev('b', 'sport', '2030-03-04T10:20:00', '2030-03-04T12:00:00')
        ];
        expect(findTightTransfers(events, 45).map(t => [t.from.id, t.to.id, t.gapMinutes])).toEqual([['a', 'b', 20]]);
    });

    it('confronta con l\'appuntamento che finisce più tardi, anche se non ordinati', () => {
        const events = [
            ev('b', 'sport', '2030-03-04T12:10:00', '2030-03-04T13:00:00'),
            ev('lungo', 'cms', '2030-03-04T08:00:00', '2030-03-04T12:00:00'),
            ev('breve', null, '2030-03-04T08:30:00', '2030-03-04T09:00:00')
        ];
        expect(findTightTransfers(events, 45).map(t => [t.from.id, t.to.id])).toEqual([['lungo', 'b']]);
    });

    it('con tempo 0 l\'avviso è disattivato', () => {
        expect(findTightTransfers([ev('a', 'cms', '2030-03-04T09:00:00', '2030-03-04T10:00:00'), ev('b', 'sport', '2030-03-04T10:00:00', '2030-03-04T11:00:00')], 0)).toEqual([]);
    });
});

describe('impostazioni della settimana tipo', () => {
    it('usa 45 minuti se non impostato e scarta le fasce non valide', () => {
        expect(agendaFns().agendaSettings()).toEqual({ weeklyTemplate: [], travelMinutes: 45 });
        const settings = agendaFns({ travelMinutes: 0, weeklyTemplate: [{ weekday: 1, centerId: 'cms', from: '14:00', to: '19:00' }, { weekday: 2, from: '13:00', to: '09:00' }, { weekday: 9, from: '09:00', to: '10:00' }] }).agendaSettings();
        expect(settings.travelMinutes).toBe(0);
        expect(settings.weeklyTemplate).toEqual([{ weekday: 1, centerId: 'cms', from: '14:00', to: '19:00' }]);
    });
});

describe('templateBackgroundEvents', () => {
    const template = { weeklyTemplate: [{ weekday: 1, centerId: 'cms', from: '14:00', to: '19:00' }, { weekday: 2, centerId: 'sport', from: '09:00', to: '13:00' }, { weekday: 1, centerId: 'studio', from: '09:00', to: '12:00' }] };

    it('genera le fasce di sfondo per i giorni della settimana visualizzata', () => {
        const { templateBackgroundEvents } = agendaFns(template);
        const bg = templateBackgroundEvents(new Date(2030, 2, 4), new Date(2030, 2, 11)); // lunedì 4 – domenica 10 marzo 2030
        expect(bg.map(e => [e.start, e.end, e.title, e.backgroundColor, e.display])).toEqual([
            ['2030-03-04T14:00:00', '2030-03-04T19:00:00', 'CMS - Carate Brianza', '#4a8fa8', 'background'],
            ['2030-03-04T09:00:00', '2030-03-04T12:00:00', 'Studio privato', '#3f5e4e', 'background'],
            ['2030-03-05T09:00:00', '2030-03-05T13:00:00', 'Medicina dello Sport', '#d97706', 'background']
        ]);
        expect(new Set(bg.map(e => e.id)).size).toBe(3);
    });

    it('nessuna fascia senza settimana tipo o senza intervallo', () => {
        expect(agendaFns().templateBackgroundEvents(new Date(2030, 2, 4), new Date(2030, 2, 11))).toEqual([]);
        expect(agendaFns(template).templateBackgroundEvents(undefined, undefined)).toEqual([]);
    });

    it('funziona attraverso il cambio dell\'ora legale', () => {
        const bg = agendaFns(template).templateBackgroundEvents(new Date(2030, 2, 25), new Date(2030, 3, 1)); // 31 marzo 2030: ora legale
        expect(bg.map(e => e.start)).toEqual(['2030-03-25T14:00:00', '2030-03-25T09:00:00', '2030-03-26T09:00:00']);
    });
});

describe('templateMismatch', () => {
    const { templateMismatch, templateMismatchMessage } = agendaFns({ weeklyTemplate: [{ weekday: 2, centerId: 'sport', from: '09:00', to: '13:00' }, { weekday: 1, centerId: 'cms', from: '14:00', to: '19:00' }] });
    const draft = (centerId, start, end) => ({ start, end, extendedProps: { centerId } });

    it('avvisa se l\'appuntamento cade nella fascia di un\'altra sede', () => {
        expect(templateMismatchMessage(draft(null, '2030-03-05T10:00:00', '2030-03-05T11:00:00')))
            .toBe('Di solito il martedì dalle 09:00 alle 13:00 sei presso Medicina dello Sport: controlla la sede.');
    });

    it('nessun avviso per la sede giusta, fuori fascia o per i calendari personali', () => {
        expect(templateMismatch(draft('sport', '2030-03-05T10:00:00', '2030-03-05T11:00:00'))).toBeNull();
        expect(templateMismatch(draft(null, '2030-03-05T13:00:00', '2030-03-05T14:00:00'))).toBeNull();
        expect(templateMismatch(draft('casa', '2030-03-05T10:00:00', '2030-03-05T11:00:00'))).toBeNull();
        expect(templateMismatch(draft(null, null, null))).toBeNull();
    });

    it('lo studio privato conta come sede', () => {
        expect(templateMismatch(draft(null, '2030-03-04T18:30:00', '2030-03-04T19:30:00'))).toMatchObject({ centerId: 'cms' });
    });
});
