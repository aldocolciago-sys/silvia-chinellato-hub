#!/usr/bin/env node
/**
 * Prima degli E2E: verifica che il CSS Tailwind compilato (assets/css/tailwind.css) sia aggiornato
 * rispetto alle classi usate nelle pagine. Il sito non usa più il Play CDN: il CSS è un file del sito,
 * generato con `npm run build:assets` (scripts/build-assets.mjs).
 */
import { readFile } from 'node:fs/promises';
import { compileTailwind, TAILWIND_CSS } from '../../scripts/build-assets.mjs';

export async function assertTailwindUpToDate() {
    const [expected, actual] = await Promise.all([compileTailwind(), readFile(TAILWIND_CSS, 'utf8').catch(() => '')]);
    if (expected !== actual) {
        throw new Error('assets/css/tailwind.css non è aggiornato rispetto alle pagine: esegui `npm run build:assets` e includi il file nel commit.');
    }
}
