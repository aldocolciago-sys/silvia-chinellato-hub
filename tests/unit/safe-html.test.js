import { describe, it, expect } from 'vitest';
import { loadFunctions } from '../support/app-source.js';

const { safeUrl, safeColor, safeIcon, escapeHtml } = loadFunctions(['safeUrl', 'safeColor', 'safeIcon', 'escapeHtml', 'escapePatientText']);

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
