#!/usr/bin/env node
/**
 * Compila offline il CSS Tailwind usato da index.html.
 *
 * In produzione la pagina usa il "Play CDN" (https://cdn.tailwindcss.com) che genera le classi
 * a runtime. Negli E2E la rete esterna non è disponibile/deterministica, quindi generiamo lo
 * stesso CSS con Tailwind v3 leggendo la configurazione inline (`tailwind.config = {...}`)
 * direttamente da index.html e scansionando tutte le classi presenti (markup + template JS).
 *
 * Output: tests/.cache/tailwind.css e tests/.cache/tailwind-cdn-stub.js (sostituto dello script CDN).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import { ROOT, readIndexHtml } from './app-source.js';

export const CACHE_DIR = path.join(ROOT, 'tests', '.cache');
export const CSS_PATH = path.join(CACHE_DIR, 'tailwind.css');
export const STUB_PATH = path.join(CACHE_DIR, 'tailwind-cdn-stub.js');

export function readInlineTailwindConfig(html = readIndexHtml()) {
    const match = html.match(/<script>\s*(tailwind\.config\s*=[\s\S]*?)<\/script>/);
    if (!match) throw new Error('Configurazione Tailwind inline non trovata');
    const tailwind = {};
    // eslint-disable-next-line no-new-func
    new Function('tailwind', match[1])(tailwind);
    return tailwind.config;
}

export async function buildTailwind() {
    const html = readIndexHtml();
    const config = { ...readInlineTailwindConfig(html), content: [{ raw: html, extension: 'html' }] };
    const result = await postcss([tailwindcss(config)]).process('@tailwind base;\n@tailwind components;\n@tailwind utilities;', { from: undefined });
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(CSS_PATH, result.css);
    const stub = `/* Sostituto di cdn.tailwindcss.com per i test: CSS precompilato. */
(function () {
    window.tailwind = window.tailwind || {};
    var css = ${JSON.stringify(result.css)};
    function inject() {
        var style = document.createElement('style');
        style.setAttribute('data-tailwind-stub', '');
        style.textContent = css;
        document.head.appendChild(style);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inject); else inject();
})();
`;
    await writeFile(STUB_PATH, stub);
    return { cssBytes: result.css.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
    const { cssBytes } = await buildTailwind();
    console.log(`Tailwind compilato (${(cssBytes / 1024).toFixed(1)} KB) in ${path.relative(ROOT, CSS_PATH)}`);
}
