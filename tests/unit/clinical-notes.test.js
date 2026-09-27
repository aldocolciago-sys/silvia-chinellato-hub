import { describe, it, expect, vi, afterEach } from 'vitest';
import { loadFunctions } from '../support/app-source.js';

const fns = loadFunctions([
    'clinicalSessionStart', 'clinicalSessionEnd', 'findClinicalSessionStart',
    'removeClinicalSessionBlock', 'buildClinicalSessionBlock', 'clinicalArchiveRecord',
    'extractLegacyClinicalBlocks', 'escapePatientText'
]);

const sampleEvent = {
    id: 'evt_1',
    title: 'Visita / Trattamento - Mario Rossi',
    start: '2030-01-15T09:00:00',
    end: '2030-01-15T10:00:00',
    extendedProps: { centerName: 'Centro Polisalute', clinicalNote: 'Lombalgia acuta', clinicalOutcome: 'Miglioramento', patientId: 'pat_1', fee: '60', paymentStatus: 'unpaid' }
};

describe('marcatori delle sedute cliniche', () => {
    it('costruisce marcatori di inizio e fine con data e ID', () => {
        expect(fns.clinicalSessionStart('evt_1', '15 gen 2030')).toBe('[APPUNTAMENTO 15 gen 2030 | ID:evt_1]');
        expect(fns.clinicalSessionEnd('evt_1', '15 gen 2030')).toBe('[FINE APPUNTAMENTO 15 gen 2030 | ID:evt_1]');
        expect(fns.clinicalSessionStart('evt_1')).toBe('[APPUNTAMENTO  | ID:evt_1]');
    });

    it('trova il marcatore moderno', () => {
        const notes = 'intro\n[APPUNTAMENTO 1 gen | ID:e1]\ncorpo\n[FINE APPUNTAMENTO 1 gen | ID:e1]';
        expect(fns.findClinicalSessionStart(notes, 'e1')).toEqual({ index: 6, marker: '[APPUNTAMENTO 1 gen | ID:e1]', legacy: false });
    });

    it('trova il marcatore legacy [SEDUTA:id]', () => {
        expect(fns.findClinicalSessionStart('ab[SEDUTA:e9]x[/SEDUTA:e9]', 'e9')).toEqual({ index: 2, marker: '[SEDUTA:e9]', legacy: true });
    });

    it('restituisce null se l’evento non è presente', () => {
        expect(fns.findClinicalSessionStart('nessun blocco', 'e1')).toBeNull();
        expect(fns.findClinicalSessionStart('solo token | ID:e1]', 'e1')).toBeNull();
    });
});

describe('removeClinicalSessionBlock', () => {
    it('rimuove un blocco moderno lasciando il resto del testo', () => {
        const notes = 'Anamnesi iniziale\n\n[APPUNTAMENTO 1 gen | ID:e1]\nNota\n[FINE APPUNTAMENTO 1 gen | ID:e1]\n\n\n\nAltro testo';
        expect(fns.removeClinicalSessionBlock(notes, 'e1')).toBe('Anamnesi iniziale\n\nAltro testo');
    });

    it('rimuove un blocco legacy', () => {
        expect(fns.removeClinicalSessionBlock('A [SEDUTA:e2]vecchio[/SEDUTA:e2] B', 'e2')).toBe('A  B');
    });

    it('non tocca i blocchi di altri eventi', () => {
        const notes = '[APPUNTAMENTO x | ID:e1]\nuno\n[FINE APPUNTAMENTO x | ID:e1]\n[APPUNTAMENTO y | ID:e2]\ndue\n[FINE APPUNTAMENTO y | ID:e2]';
        const result = fns.removeClinicalSessionBlock(notes, 'e2');
        expect(result).toContain('ID:e1');
        expect(result).not.toContain('ID:e2');
    });

    it('restituisce il testo invariato (trim) se il blocco non è chiuso', () => {
        expect(fns.removeClinicalSessionBlock('  [APPUNTAMENTO x | ID:e1]\nsenza fine  ', 'e1')).toBe('[APPUNTAMENTO x | ID:e1]\nsenza fine');
        expect(fns.removeClinicalSessionBlock('[SEDUTA:e1] senza fine', 'e1')).toBe('[SEDUTA:e1] senza fine');
    });

    it('gestisce note nulle o vuote', () => {
        expect(fns.removeClinicalSessionBlock(null, 'e1')).toBe('');
        expect(fns.removeClinicalSessionBlock(undefined, 'e1')).toBe('');
    });
});

describe('buildClinicalSessionBlock', () => {
    it('include titolo, sede, nota ed esito', () => {
        const block = fns.buildClinicalSessionBlock(sampleEvent);
        expect(block.startsWith('[APPUNTAMENTO ')).toBe(true);
        expect(block).toContain('| ID:evt_1]');
        expect(block).toContain('Visita / Trattamento - Mario Rossi');
        expect(block).toContain('Sede:\nCentro Polisalute');
        expect(block).toContain('Nota seduta:\nLombalgia acuta');
        expect(block).toContain('Esito:\nMiglioramento');
        expect(block.trim().endsWith('| ID:evt_1]')).toBe(true);
    });

    it('usa valori predefiniti per titolo e sede e omette sezioni vuote', () => {
        const block = fns.buildClinicalSessionBlock({ id: 'e2', start: '2030-01-15T09:00:00', extendedProps: {} });
        expect(block).toContain('Appuntamento');
        expect(block).toContain('Studio Privato');
        expect(block).not.toContain('Nota seduta');
        expect(block).not.toContain('Esito');
    });

    it('usa la stringa originale se la data non è valida', () => {
        const block = fns.buildClinicalSessionBlock({ id: 'e3', start: 'data-rotta', extendedProps: {} });
        expect(block).toContain('[APPUNTAMENTO data-rotta | ID:e3]');
    });

    it('è rimovibile con removeClinicalSessionBlock (round-trip)', () => {
        const notes = `Prima\n\n${fns.buildClinicalSessionBlock(sampleEvent)}\n\nDopo`;
        expect(fns.removeClinicalSessionBlock(notes, 'evt_1')).toBe('Prima\n\nDopo');
    });

    it('è estraibile con extractLegacyClinicalBlocks (round-trip)', () => {
        const { blocks, cleaned } = fns.extractLegacyClinicalBlocks(`Anamnesi\n${fns.buildClinicalSessionBlock(sampleEvent)}`);
        expect(cleaned).toBe('Anamnesi');
        expect(blocks).toHaveLength(1);
        expect(blocks[0]).toMatchObject({
            eventId: 'evt_1',
            title: 'Visita / Trattamento - Mario Rossi',
            centerName: 'Centro Polisalute',
            clinicalNote: 'Lombalgia acuta',
            clinicalOutcome: 'Miglioramento'
        });
    });
});

describe('clinicalArchiveRecord', () => {
    afterEach(() => vi.useRealTimers());

    it('normalizza i dati dell’evento in un record di archivio', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2030-02-01T10:00:00Z'));
        expect(fns.clinicalArchiveRecord(sampleEvent)).toEqual({
            id: 'evt_1', eventId: 'evt_1', patientId: 'pat_1',
            title: 'Visita / Trattamento - Mario Rossi',
            start: '2030-01-15T09:00:00', end: '2030-01-15T10:00:00',
            centerId: null, centerName: 'Centro Polisalute',
            clinicalNote: 'Lombalgia acuta', clinicalOutcome: 'Miglioramento',
            fee: 60, paymentStatus: 'unpaid', detachedFromExternal: false,
            updatedAt: '2030-02-01T10:00:00.000Z'
        });
    });

    it('applica i valori predefiniti quando mancano extendedProps', () => {
        const record = fns.clinicalArchiveRecord({ id: 'x' });
        expect(record).toMatchObject({ patientId: null, title: 'Appuntamento', start: null, end: null, centerName: 'Studio Privato', fee: 0, paymentStatus: 'paid', clinicalNote: '', clinicalOutcome: '' });
    });
});

describe('extractLegacyClinicalBlocks', () => {
    it('estrae blocchi legacy [SEDUTA] e moderni dallo stesso testo', () => {
        const notes = [
            'Paziente collaborante.',
            '[SEDUTA:old1]',
            'Seduta di prova',
            'Sede: Studio Privato',
            'Nota seduta: prima nota',
            'Esito: ok',
            '[/SEDUTA:old1]',
            '[APPUNTAMENTO 3 mar 2030, 10:00 | ID:new1]',
            'Trattamento osteopatico',
            'Sede:',
            'Centro Polisalute',
            'Nota seduta:',
            'cervicale',
            '[FINE APPUNTAMENTO 3 mar 2030, 10:00 | ID:new1]'
        ].join('\n');
        const { blocks, cleaned } = fns.extractLegacyClinicalBlocks(notes);
        expect(cleaned).toBe('Paziente collaborante.');
        expect(blocks.map(b => b.eventId).sort()).toEqual(['new1', 'old1']);
        const modern = blocks.find(b => b.eventId === 'new1');
        expect(modern.dateText).toBe('3 mar 2030, 10:00');
        expect(modern.title).toBe('Trattamento osteopatico');
        expect(modern.clinicalNote).toBe('cervicale');
        expect(modern.clinicalOutcome).toBe('');
        const legacy = blocks.find(b => b.eventId === 'old1');
        expect(legacy).toMatchObject({ dateText: '', title: 'Seduta di prova', centerName: 'Studio Privato', clinicalNote: 'prima nota', clinicalOutcome: 'ok' });
    });

    it('non estrae blocchi con ID di chiusura diverso', () => {
        const { blocks, cleaned } = fns.extractLegacyClinicalBlocks('[SEDUTA:a]x[/SEDUTA:b]');
        expect(blocks).toHaveLength(0);
        expect(cleaned).toBe('[SEDUTA:a]x[/SEDUTA:b]');
    });

    it('restituisce un risultato vuoto per note assenti', () => {
        expect(fns.extractLegacyClinicalBlocks(undefined)).toEqual({ blocks: [], cleaned: '' });
    });

    it('usa "Seduta clinica" come titolo se il blocco contiene solo metadati', () => {
        const { blocks } = fns.extractLegacyClinicalBlocks('[SEDUTA:z]\nSede: X\n[/SEDUTA:z]');
        expect(blocks[0].title).toBe('Seduta clinica');
        expect(blocks[0].centerName).toBe('X');
    });
});

describe('escapePatientText', () => {
    it('esegue l’escape di tutti i caratteri HTML pericolosi', () => {
        expect(fns.escapePatientText(`<img src=x onerror="alert('x')">&`)).toBe('&lt;img src=x onerror=&quot;alert(&#039;x&#039;)&quot;&gt;&amp;');
    });
    it.each([null, undefined, '', 0])('restituisce stringa vuota per %s', (value) => {
        expect(fns.escapePatientText(value)).toBe('');
    });
});
