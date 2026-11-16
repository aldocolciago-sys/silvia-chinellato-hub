import { describe, it, expect } from 'vitest';
import { loadFunctions } from '../support/app-source.js';

const { safeUrl, safeColor, safeIcon, escapeHtml, formatRichText, safeImageSrc } = loadFunctions(['safeUrl', 'safeColor', 'safeIcon', 'escapeHtml', 'escapePatientText', 'formatRichText', 'safeImageSrc']);

describe('safeUrl', () => {
    it.each([
        ['https://example.com/prenota?x=1&y=2', 'https://example.com/prenota?x=1&amp;y=2'],
        ['  http://example.com  ', 'http://example.com'],
        ['mailto:silviachine@gmail.com', 'mailto:silviachine@gmail.com'],
        ['HTTPS://EXAMPLE.COM', 'HTTPS://EXAMPLE.COM']
    ])('accetta %s', (input, expected) => {
        expect(safeUrl(input)).toBe(expected);
    });

    it.each(['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,<script>', 'vbscript:x', '//evil.example', 'example.com', '', null, undefined])(
        'rifiuta %s', (input) => {
            expect(safeUrl(input)).toBe('');
        }
    );

    it('esegue l’escape delle virgolette per non uscire dall’attributo', () => {
        expect(safeUrl('https://x.example/"onmouseover="alert(1)')).toBe('https://x.example/&quot;onmouseover=&quot;alert(1)');
    });
});

describe('safeColor', () => {
    it.each(['#3f5e4e', '#FFF', '#12345678'])('accetta %s', (c) => expect(safeColor(c)).toBe(c));
    it.each(['red;background:url(x)', 'rgb(0,0,0)', '', null, '#12'])('sostituisce %s con il colore predefinito', (c) => {
        expect(safeColor(c)).toBe('#3f5e4e');
        expect(safeColor(c, '#000')).toBe('#000');
    });
});

describe('safeIcon', () => {
    it('accetta classi Font Awesome', () => expect(safeIcon('fa-hospital', 'x')).toBe('fa-hospital'));
    it.each(['fa-x" onmouseover="alert(1)', 'bi-star', '', undefined])('usa il valore predefinito per %s', (v) => {
        expect(safeIcon(v, 'fa-spa')).toBe('fa-spa');
    });
});

describe('escapeHtml', () => {
    it('è equivalente a escapePatientText', () => {
        expect(escapeHtml('<b a="1">&\'')).toBe('&lt;b a=&quot;1&quot;&gt;&amp;&#039;');
    });
});

describe('formatRichText', () => {
    it.each([
        ['Orari **nuovi** da lunedì', 'Orari <strong>nuovi</strong> da lunedì'],
        ['Un consiglio *importante*.', 'Un consiglio <em>importante</em>.'],
        ['***Attenzione***', '<strong><em>Attenzione</em></strong>'],
        ['**Grassetto con *corsivo* dentro**', '<strong>Grassetto con <em>corsivo</em> dentro</strong>'],
        ['Prima riga\nSeconda riga\r\n\r\nQuarta', 'Prima riga<br>Seconda riga<br><br>Quarta'],
        ['**uno** e **due**', '<strong>uno</strong> e <strong>due</strong>'],
        ['  testo semplice  ', 'testo semplice']
    ])('formatta %j', (input, expected) => {
        expect(formatRichText(input)).toBe(expected);
    });

    it.each([
        ['5 * 3 * 2 = 30', '5 * 3 * 2 = 30'],
        ['Sconto 10%* fino a fine mese', 'Sconto 10%* fino a fine mese'],
        ['**non chiuso', '**non chiuso'],
        ['*riga uno\nriga due*', '*riga uno<br>riga due*']
    ])('lascia invariati gli asterischi che non sono formattazione: %j', (input, expected) => {
        expect(formatRichText(input)).toBe(expected);
    });

    it('neutralizza sempre l’HTML scritto nel testo', () => {
        expect(formatRichText('<b>x</b> **<img src=x onerror=alert(1)>**')).toBe('&lt;b&gt;x&lt;/b&gt; <strong>&lt;img src=x onerror=alert(1)&gt;</strong>');
        expect(formatRichText('*<script>alert(1)</script>*')).not.toContain('<script');
    });

    it.each([null, undefined, ''])('restituisce una stringa vuota per %s', (v) => expect(formatRichText(v)).toBe(''));
});

describe('safeImageSrc', () => {
    it.each(['data:image/jpeg;base64,/9j/4AAQ', 'data:image/png;base64,iVBORw0KGgo=', 'data:image/webp;base64,UklGRg=='])('accetta %s', (src) => {
        expect(safeImageSrc(src)).toBe(src);
    });
    it.each([
        'https://example.com/foto.jpg', 'javascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', 'data:image/svg+xml;base64,PHN2Zz4=',
        'data:image/jpeg;base64,AAAA" onerror="alert(1)', 'data:image/jpeg;base64,', '', null, undefined
    ])('rifiuta %s', (src) => expect(safeImageSrc(src)).toBe(''));
    it('rifiuta immagini troppo pesanti per un documento Firestore', () => {
        expect(safeImageSrc('data:image/jpeg;base64,' + 'A'.repeat(900000))).toBe('');
    });
});
