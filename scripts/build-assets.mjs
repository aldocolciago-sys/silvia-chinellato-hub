#!/usr/bin/env node
/**
 * Prepara in assets/ tutto ciò che prima il sito scaricava da servizi esterni
 * (Google Fonts, cdnjs, jsDelivr, cdn.tailwindcss.com), così l'indirizzo IP dei
 * visitatori non viene inviato a terzi solo per mostrare la pagina:
 *  - font Cormorant Garamond e Plus Jakarta Sans (pacchetti @fontsource, licenza OFL);
 *  - icone Font Awesome Free 6.4.0;
 *  - FullCalendar 6.1.8;
 *  - CSS Tailwind compilato da index.html e privacy.html.
 *
 * Uso: npm run build:assets (da rilanciare dopo aver cambiato classi CSS nelle pagine:
 * un test segnala se assets/css/tailwind.css non è aggiornato).
 */
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import tailwindConfig from '../tailwind.config.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE_MODULES = path.join(ROOT, 'node_modules');
export const ASSETS = path.join(ROOT, 'assets');
export const TAILWIND_CSS = path.join(ASSETS, 'css', 'tailwind.css');

/** Pesi e stili usati dal sito (gli stessi che prima si chiedevano a Google Fonts). */
export const FONTS = [
    { pkg: 'cormorant-garamond', variants: ['400', '500', '600', '700', '400-italic', '500-italic', '600-italic', '700-italic'] },
    { pkg: 'plus-jakarta-sans', variants: ['300', '400', '500', '600', '700', '300-italic', '400-italic'] }
];
/** Solo i caratteri latini (italiano, lettere accentate e simboli): niente cirillico o vietnamita. */
const SUBSETS = ['latin', 'latin-ext'];

async function buildFonts() {
    const outDir = path.join(ASSETS, 'fonts');
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
    const blocks = [];
    for (const { pkg, variants } of FONTS) {
        const base = path.join(NODE_MODULES, '@fontsource', pkg);
        for (const variant of variants) {
            const css = await readFile(path.join(base, `${variant}.css`), 'utf8');
            for (const match of css.matchAll(/\/\* ([\w-]+) \*\/\s*@font-face\s*\{([^}]*)\}/g)) {
                const [, name, body] = match;
                const suffix = variant.includes('-') ? variant : `${variant}-normal`;
                if (!SUBSETS.some(subset => name === `${pkg}-${subset}-${suffix}`)) continue;
                const file = /url\(\.\/files\/([^)]+\.woff2)\)/.exec(body)?.[1];
                if (!file) continue;
                await copyFile(path.join(base, 'files', file), path.join(outDir, file));
                const src = `  src: url(/assets/fonts/${file}) format('woff2');`;
                blocks.push(`/* ${name} */\n@font-face {${body.replace(/\n\s*src:[^;]*;/, `\n${src}`)}}`);
            }
        }
        await copyFile(path.join(base, 'LICENSE'), path.join(outDir, `LICENSE-${pkg}.txt`));
    }
    await mkdir(path.join(ASSETS, 'css'), { recursive: true });
    await writeFile(path.join(ASSETS, 'css', 'fonts.css'), `/* Generato da scripts/build-assets.mjs: font serviti dal sito, non da Google Fonts. */\n${blocks.join('\n')}\n`);
    return blocks.length;
}

async function buildFontAwesome() {
    const base = path.join(NODE_MODULES, '@fortawesome', 'fontawesome-free');
    const outDir = path.join(ASSETS, 'fontawesome');
    await rm(outDir, { recursive: true, force: true });
    await mkdir(path.join(outDir, 'css'), { recursive: true });
    await mkdir(path.join(outDir, 'webfonts'), { recursive: true });
    await copyFile(path.join(base, 'css', 'all.min.css'), path.join(outDir, 'css', 'all.min.css'));
    for (const file of await readdir(path.join(base, 'webfonts'))) {
        await copyFile(path.join(base, 'webfonts', file), path.join(outDir, 'webfonts', file));
    }
    await copyFile(path.join(base, 'LICENSE.txt'), path.join(outDir, 'LICENSE.txt'));
}

async function buildFullCalendar() {
    const base = path.join(NODE_MODULES, 'fullcalendar');
    const { version } = JSON.parse(await readFile(path.join(base, 'package.json'), 'utf8'));
    const outDir = path.join(ASSETS, 'vendor');
    await mkdir(outDir, { recursive: true });
    await copyFile(path.join(base, 'index.global.min.js'), path.join(outDir, 'fullcalendar.min.js'));
    await copyFile(path.join(base, 'LICENSE.md'), path.join(outDir, 'LICENSE-fullcalendar.md'));
    return version;
}

/** CSS Tailwind compilato dalle classi presenti nelle pagine (markup e template JavaScript). */
export async function compileTailwind() {
    const content = await Promise.all(tailwindConfig.content.map(async file => ({ raw: await readFile(path.join(ROOT, file), 'utf8'), extension: 'html' })));
    const result = await postcss([tailwindcss({ ...tailwindConfig, content })]).process('@tailwind base;\n@tailwind components;\n@tailwind utilities;', { from: undefined });
    return `/* Generato da scripts/build-assets.mjs (npm run build:assets): non modificare a mano. */\n${result.css}`;
}

export async function buildAll() {
    const fonts = await buildFonts();
    await buildFontAwesome();
    const fullcalendar = await buildFullCalendar();
    const css = await compileTailwind();
    await writeFile(TAILWIND_CSS, css);
    return { fonts, fullcalendar, cssBytes: css.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { fonts, fullcalendar, cssBytes } = await buildAll();
    console.log(`Asset pronti: ${fonts} font, Font Awesome, FullCalendar ${fullcalendar}, Tailwind ${(cssBytes / 1024).toFixed(1)} KB`);
}
