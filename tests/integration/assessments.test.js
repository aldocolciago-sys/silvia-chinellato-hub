import { describe, it, expect, afterEach } from 'vitest';
import { bootApp, SHARED } from '../support/jsdom-app.js';
import { seedDocs, center, patient } from '../fixtures/seed.js';

let app;
afterEach(() => app?.close());

const IDRO_IDS = ['gravidanza', 'mici', 'diverticolite', 'emorroidi', 'chirurgia', 'ernia', 'cuore_reni', 'ipertensione', 'tumori', 'anemia', 'sanguinamento'];
const allNo = (ids) => Object.fromEntries(ids.map(id => [id, { answer: 'no', note: '' }]));

async function loggedIn(patients) {
    app = await bootApp({
        docs: seedDocs({
            centers: [
                center({ id: 'cms', name: 'CMS - Carate Brianza', service: 'Idrocolonterapia' }),
                center({ id: 'casa', name: 'Agenda personale', isNonClinicalCalendar: true, showPublic: false, includeInFinance: false })
            ],
            patients: patients || [patient({ id: 'p1', name: 'Mario Rossi', phone: '333 1234567' })]
        })
    });
    await app.login();
    app.window.closeSyncReportModal();
    return app;
}

const radio = (key, item, value) => app.$(`input[name="assess-${key}-${item}"][value="${value}"]`);

describe('valutazione pre-trattamento nella scheda paziente', () => {
    it('mostra le due liste da compilare', async () => {
        await loggedIn();
        app.window.editPatientById('p1');
        expect(app.$$('#patient-assessments-container details').map(d => d.dataset.assessment)).toEqual(['idrocolonterapia', 'osteopatia']);
        expect(app.$$('#assessment-idrocolonterapia [data-assessment-item]').length).toBe(11);
        expect(app.$$('#assessment-osteopatia [data-assessment-item]').length).toBe(9);
        expect(app.text('assessment-idrocolonterapia-badge')).toBe('Da compilare');
    });

    it('salva risposte, note, data e verifica, e le ricarica', async () => {
        await loggedIn();
        app.window.editPatientById('p1');
        app.window.markAssessmentAllNo('idrocolonterapia');
        radio('idrocolonterapia', 'diverticolite', 'yes').checked = true;
        app.setValue('assess-idrocolonterapia-diverticolite-note', 'Episodio a gennaio, chiedere al medico');
        app.setValue('assess-idrocolonterapia-date', '2030-03-01');
        app.byId('assess-idrocolonterapia-verified').checked = true;
        app.setValue('assess-idrocolonterapia-notes', 'Rivalutare tra 3 mesi');
        await app.submit('patient-form');

        const saved = app.mock.get(`${SHARED}/patients_list/p1`).assessments;
        expect(saved.osteopatia).toBeNull();
        expect(saved.idrocolonterapia).toMatchObject({ date: '2030-03-01', verified: true, notes: 'Rivalutare tra 3 mesi' });
        expect(saved.idrocolonterapia.items.diverticolite).toEqual({ answer: 'yes', note: 'Episodio a gennaio, chiedere al medico' });
        expect(saved.idrocolonterapia.items.gravidanza).toEqual({ answer: 'no', note: '' });

        app.window.editPatientById('p1');
        expect(radio('idrocolonterapia', 'diverticolite', 'yes').checked).toBe(true);
        expect(radio('idrocolonterapia', 'anemia', 'no').checked).toBe(true);
        expect(app.byId('assess-idrocolonterapia-diverticolite-note').value).toBe('Episodio a gennaio, chiedere al medico');
        expect(app.byId('assess-idrocolonterapia-verified').checked).toBe(true);
        expect(app.text('assessment-idrocolonterapia-badge')).toBe('1 da verificare');
    });

    it('"Segna tutte No" compila anche la data di oggi', async () => {
        await loggedIn();
        app.window.editPatientById('p1');
        app.window.markAssessmentAllNo('osteopatia');
        expect(app.$$('#assessment-osteopatia input[value="no"]').every(r => r.checked)).toBe(true);
        expect(app.byId('assess-osteopatia-date').value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
});

describe('avviso nel modulo appuntamento', () => {
    function openWithPatient(centerId, title) {
        app.window.openStudioModal();
        app.setValue('studio-center-select', centerId);
        app.window.onStudioCenterChange();
        app.setValue('studio-patient-select', 'p1');
        app.window.onPatientSelectChange();
        if (title) { app.setValue('studio-title', title); app.window.updateStudioAssessmentWarning(); }
    }

    it('valutazione mancante per l\'idrocolonterapia', async () => {
        await loggedIn();
        openWithPatient('cms');
        expect(app.isHidden('studio-assessment-warning')).toBe(false);
        expect(app.text('studio-assessment-text')).toBe('⚠️ Valutazione pre-trattamento per Idrocolonterapia mancante: verificare le controindicazioni prima della seduta.');
        expect(app.isHidden('studio-assessment-open')).toBe(false);
    });

    it('elenca le controindicazioni segnate', async () => {
        await loggedIn([patient({ id: 'p1', name: 'Mario Rossi', assessments: { idrocolonterapia: { date: '2030-03-01', items: { ...allNo(IDRO_IDS), gravidanza: { answer: 'yes', note: '' }, ernia: { answer: 'yes', note: '' } } } } })]);
        openWithPatient('cms');
        expect(app.text('studio-assessment-text')).toBe('⚠️ Controindicazioni da verificare (Idrocolonterapia): Gravidanza o sospetta gravidanza; Ernia addominale o inguinale.');
    });

    it('conferma in verde se tutto è a posto', async () => {
        await loggedIn([patient({ id: 'p1', name: 'Mario Rossi', assessments: { idrocolonterapia: { date: '2030-03-01', items: allNo(IDRO_IDS) } } })]);
        openWithPatient('cms');
        expect(app.text('studio-assessment-text')).toBe('✓ Valutazione per Idrocolonterapia del 1 mar 2030: nessuna controindicazione segnalata.');
        expect(app.byId('studio-assessment-warning').classList.contains('bg-emerald-50')).toBe(true);
        expect(app.isHidden('studio-assessment-open')).toBe(true);
    });

    it('avvisa anche per l\'osteopatia (studio privato)', async () => {
        await loggedIn();
        openWithPatient('', 'Trattamento osteopatico - Mario Rossi');
        expect(app.text('studio-assessment-text')).toBe('⚠️ Valutazione pre-trattamento per Osteopatia mancante: verificare le controindicazioni prima della seduta.');
    });

    it('niente avviso senza paziente', async () => {
        await loggedIn();
        app.window.openStudioModal();
        expect(app.isHidden('studio-assessment-warning')).toBe(true);
    });

    it('compilando la scheda dal modulo appuntamento l\'avviso si aggiorna', async () => {
        await loggedIn();
        openWithPatient('cms');
        app.window.editSelectedPatientFromAppointment();
        expect(app.isHidden('patient-edit-modal')).toBe(false);
        app.window.markAssessmentAllNo('idrocolonterapia');
        await app.submit('patient-form');
        expect(app.isHidden('studio-modal')).toBe(false);
        expect(app.text('studio-assessment-text')).toMatch(/^✓ Valutazione per Idrocolonterapia del /);
    });
});
