import { describe, it, expect } from 'vitest';
import { loadFunctions } from '../support/app-source.js';

const { validateAppointmentRequest, isLikelySpam, requestReplyText } = loadFunctions(
    ['validateAppointmentRequest', 'isLikelySpam', 'requestReplyText'], {}, { consts: ['REQUEST_MIN_FILL_MS', 'REQUEST_TREATMENTS'] }
);
const valid = (extra = {}) => ({ name: 'Anna Bianchi', phone: '333 1234567', email: '', preferredDays: '', message: '', consent: true, treatment: 'osteopatia', ...extra });

describe('validateAppointmentRequest', () => {
    it('accetta una richiesta completa o minima', () => {
        expect(validateAppointmentRequest(valid())).toEqual([]);
        expect(validateAppointmentRequest(valid({ email: 'anna@example.com', preferredDays: 'martedì', message: 'Mal di schiena' }))).toEqual([]);
        expect(validateAppointmentRequest(valid({ treatment: 'idrocolonterapia' }))).toEqual([]);
    });

    it.each([
        ['nome mancante', { name: ' ' }, 'Indichi nome e cognome.'],
        ['telefono troppo corto', { phone: '12 34' }, 'Indichi un numero di telefono valido.'],
        ['telefono senza cifre', { phone: 'chiamatemi' }, 'Indichi un numero di telefono valido.'],
        ['email non valida', { email: 'anna@' }, "L'indirizzo email non è valido."],
        ['messaggio troppo lungo', { message: 'x'.repeat(1001) }, 'Alcuni campi sono troppo lunghi.'],
        ['senza trattamento', { treatment: '' }, 'Scelga il trattamento di interesse (osteopatia o idrocolonterapia).'],
        ['trattamento non previsto', { treatment: 'massaggio' }, 'Scelga il trattamento di interesse (osteopatia o idrocolonterapia).'],
        ['senza consenso', { consent: false }, 'Per inviare la richiesta serve il consenso al trattamento dei dati.']
    ])('%s', (_, extra, error) => {
        expect(validateAppointmentRequest(valid(extra))).toContain(error);
    });
});

describe('isLikelySpam', () => {
    const now = 1_000_000;
    it('campo nascosto compilato → spam', () => {
        expect(isLikelySpam({ honeypot: 'http://spam', startedAt: now - 60000, now })).toBe(true);
    });
    it('compilato in meno di 3 secondi o senza interazione → spam', () => {
        expect(isLikelySpam({ honeypot: '', startedAt: now - 1000, now })).toBe(true);
        expect(isLikelySpam({ honeypot: '', startedAt: undefined, now })).toBe(true);
    });
    it('compilazione normale → valida', () => {
        expect(isLikelySpam({ honeypot: '', startedAt: now - 30000, now })).toBe(false);
    });
});

describe('requestReplyText', () => {
    it('risposta formale con il nome e il trattamento', () => {
        expect(requestReplyText({ name: ' Anna Bianchi ', treatment: 'osteopatia' })).toMatch(/^Gentile Anna Bianchi, sono Silvia Chinellato: ho ricevuto la sua richiesta riguardante l'osteopatia\./);
        expect(requestReplyText({ name: 'Luca', treatment: 'idrocolonterapia' })).toContain("riguardante l'idrocolonterapia.");
    });
});
