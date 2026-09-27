import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { loadFunctions } from '../support/app-source.js';

const f = loadFunctions(['escapeReport', 'pendingDeletionCount', 'buildChangeSection', 'buildDeletedSection', 'buildSyncDecisionReport', 'formatDeletionEventDate']);

const render = (html) => new JSDOM(`<body>${html}</body>`).window.document;

const report = {
    syncedAt: '2030-01-01T10:00:00.000Z',
    centers: ['Centro A', 'Centro B', 'Centro A'],
    added: [{ title: 'Nuovo <b>paziente</b>', center: 'Centro A', when: '15 gen 2030 alle 09:00' }],
    modified: [{ title: 'Spostato', center: 'Centro A', when: '16 gen 2030 alle 10:00' }],
    deleted: [
        { id: 'ical_1_x', title: 'Cancellato', center: 'Centro A', when: '17 gen', decision: null },
        { id: 'ical_1_y', title: 'Già deciso', center: 'Centro A', when: '18 gen', decision: 'keep' }
    ]
};

describe('pendingDeletionCount', () => {
    it('conta solo le cancellazioni senza decisione', () => {
        expect(f.pendingDeletionCount(report)).toBe(1);
    });
    it('gestisce report nulli o senza sezione deleted', () => {
        expect(f.pendingDeletionCount(null)).toBe(0);
        expect(f.pendingDeletionCount({})).toBe(0);
    });
});

describe('buildChangeSection', () => {
    it('restituisce stringa vuota senza elementi', () => {
        expect(f.buildChangeSection('Aggiunti', [], 'x')).toBe('');
    });
    it('mostra conteggio e testo con escape HTML', () => {
        const doc = render(f.buildChangeSection('Aggiunti', report.added, 'bg-emerald-50'));
        expect(doc.body.textContent).toContain('Aggiunti (1)');
        expect(doc.querySelector('b b')).toBeNull();
        expect(doc.body.textContent).toContain('Nuovo <b>paziente</b>');
    });
});

describe('buildDeletedSection', () => {
    it('mostra pulsanti di scelta solo per gli elementi senza decisione', () => {
        const doc = render(f.buildDeletedSection(report.deleted));
        const buttons = [...doc.querySelectorAll('button')];
        expect(buttons).toHaveLength(2);
        expect(buttons[0].getAttribute('onclick')).toBe("requestExternalDeletionDecision('ical_1_x','keep')");
        expect(buttons[1].getAttribute('onclick')).toBe("requestExternalDeletionDecision('ical_1_x','remove')");
        expect(doc.body.textContent).toContain('Scelta registrata: mantieni nella mia agenda');
    });
    it('descrive correttamente la scelta di rimozione', () => {
        const doc = render(f.buildDeletedSection([{ id: 'a', title: 't', decision: 'remove' }]));
        expect(doc.body.textContent).toContain('rimuovi dalla mia agenda');
    });
});

describe('buildSyncDecisionReport', () => {
    it('mostra riepilogo, avviso obbligatorio e una sezione per sede (senza duplicati)', () => {
        const doc = render(f.buildSyncDecisionReport(report));
        expect(doc.querySelectorAll('section')).toHaveLength(2);
        expect(doc.body.textContent).toContain('Scelta obbligatoria');
        expect(doc.body.textContent).toContain('decidi cosa fare per 1 appuntamenti');
        const summary = [...doc.querySelectorAll('.grid.grid-cols-3 b')].map(b => b.textContent);
        expect(summary).toEqual(['1', '1', '2']);
        const [a, b] = doc.querySelectorAll('section');
        expect(a.textContent).toContain('4 variazioni');
        expect(b.textContent).toContain('Nessuna variazione');
    });
    it('non mostra l’avviso quando non ci sono decisioni pendenti', () => {
        const doc = render(f.buildSyncDecisionReport({ ...report, deleted: [] }));
        expect(doc.body.textContent).not.toContain('Scelta obbligatoria');
    });
    it('esegue l’escape del nome della sede', () => {
        const doc = render(f.buildSyncDecisionReport({ centers: ['<img src=x onerror=alert(1)>'], added: [], modified: [], deleted: [] }));
        expect(doc.querySelector('img')).toBeNull();
    });
});

describe('buildSyncDecisionReport con sedi non sincronizzate', () => {
    const failedReport = { centers: ['Centro A', 'Centro B'], failed: ['Centro B'], added: [], modified: [], deleted: [] };

    it('mostra un avviso generale e un badge di errore per la sede', () => {
        const doc = render(f.buildSyncDecisionReport(failedReport));
        expect(doc.body.textContent).toContain('Errore di sincronizzazione: non è stato possibile scaricare il calendario di Centro B');
        const [a, b] = doc.querySelectorAll('section');
        expect(a.textContent).toContain('Nessuna variazione');
        expect(b.textContent).toContain('Errore di sincronizzazione');
        expect(b.textContent).toContain('Calendario non sincronizzato');
        expect(b.textContent).not.toContain('Nessuna variazione');
    });

    it('è compatibile con i report salvati prima dell’introduzione del campo "failed"', () => {
        const doc = render(f.buildSyncDecisionReport({ centers: ['X'], added: [], modified: [], deleted: [] }));
        expect(doc.body.textContent).not.toContain('Errore di sincronizzazione');
    });
});

describe('formatDeletionEventDate', () => {
    it('formatta una data ISO in italiano', () => {
        expect(f.formatDeletionEventDate('2030-01-15T08:00:00.000Z')).toMatch(/15 gen 2030/);
    });
    it('restituisce il valore originale se non è una data', () => {
        expect(f.formatDeletionEventDate('boh')).toBe('boh');
        expect(f.formatDeletionEventDate(undefined)).toBe('');
    });
});

describe('escapeReport', () => {
    it('esegue l’escape di & < > " \'', () => {
        expect(f.escapeReport(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#039;');
    });
});
