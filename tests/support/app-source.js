/**
 * Utilità per leggere e analizzare il sorgente dell'applicazione (index.html)
 * senza modificarlo: tutta la logica vive in un unico <script type="module"> inline.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as acorn from 'acorn';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const INDEX_PATH = path.join(ROOT, 'index.html');

let cachedHtml = null;
export function readIndexHtml() {
    if (cachedHtml === null) cachedHtml = readFileSync(INDEX_PATH, 'utf8');
    return cachedHtml;
}

/** Restituisce il contenuto del modulo inline principale. */
export function getModuleScript(html = readIndexHtml()) {
    const match = html.match(/<script type="module">([\s\S]*?)<\/script>/);
    if (!match) throw new Error('Script modulo inline non trovato in index.html');
    return match[1];
}

let cachedAst = null;
export function parseModuleScript() {
    if (!cachedAst) {
        cachedAst = acorn.parse(getModuleScript(), { ecmaVersion: 'latest', sourceType: 'module' });
    }
    return cachedAst;
}

/** Nomi di tutte le funzioni dichiarate al livello superiore del modulo. */
export function topLevelFunctionNames() {
    return parseModuleScript().body.filter(n => n.type === 'FunctionDeclaration').map(n => n.id.name);
}

/** Nomi delle funzioni assegnate a `window.xxx = function ...` (handler usati dagli attributi onclick). */
export function windowFunctionNames() {
    const names = [];
    for (const node of parseModuleScript().body) {
        if (node.type !== 'ExpressionStatement' || node.expression.type !== 'AssignmentExpression') continue;
        const left = node.expression.left;
        if (left.type === 'MemberExpression' && left.object.name === 'window' && left.property.type === 'Identifier') {
            names.push(left.property.name);
        }
    }
    return names;
}

/** Sorgente di una funzione dichiarata al livello superiore. */
export function functionSource(name) {
    const script = getModuleScript();
    const node = parseModuleScript().body.find(n => n.type === 'FunctionDeclaration' && n.id.name === name);
    if (!node) throw new Error(`Funzione "${name}" non trovata in index.html`);
    return script.slice(node.start, node.end);
}

/** Sorgente di una dichiarazione `const NAME = ...` al livello superiore. */
export function constSource(name) {
    const script = getModuleScript();
    const node = parseModuleScript().body.find(n => n.type === 'VariableDeclaration'
        && n.declarations.some(d => d.id.type === 'Identifier' && d.id.name === name));
    if (!node) throw new Error(`Costante "${name}" non trovata in index.html`);
    return script.slice(node.start, node.end);
}

/**
 * Estrae le funzioni indicate da index.html e le valuta in un contesto isolato.
 * `context` fornisce le variabili libere di cui le funzioni hanno bisogno (es. appState, atob).
 * Le funzioni estratte possono chiamarsi a vicenda.
 *
 * @example
 *   const { parseIcalDateTime } = loadFunctions(['parseIcalDateTime']);
 */
export function loadFunctions(names, context = {}, { consts = [] } = {}) {
    const body = [
        ...consts.map(constSource),
        ...names.map(functionSource),
        `return { ${names.join(', ')} };`
    ].join('\n\n');
    const keys = Object.keys(context);
    // eslint-disable-next-line no-new-func
    const factory = new Function(...keys, `"use strict";\n${body}`);
    return factory(...keys.map(k => context[k]));
}

/** Tutti gli id definiti nel markup HTML statico. */
export function staticElementIds(html = readIndexHtml()) {
    const withoutScripts = html.replace(/<script[\s\S]*?<\/script>/g, '');
    return [...withoutScripts.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
}
