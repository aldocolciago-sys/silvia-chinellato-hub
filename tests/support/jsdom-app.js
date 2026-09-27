/**
 * Harness di integrazione: esegue l'intero script dell'applicazione dentro jsdom,
 * sostituendo le dipendenze esterne (Firebase, FullCalendar, Tailwind) con doppi di test.
 *
 * Lo script originale non viene modificato su disco: in memoria le istruzioni `import`
 * vengono sostituite con il mock Firebase e in coda viene aggiunto un "ponte" che espone
 * lo stato interno (`appState`) e tutte le funzioni di primo livello in `window.__app`.
 */
import { JSDOM } from 'jsdom';
import { readIndexHtml, getModuleScript, parseModuleScript, topLevelFunctionNames } from './app-source.js';
import * as firebaseMock from '../mocks/firebase/firebase-mock-core.js';

import { AUTHORIZED_EMAIL } from '../fixtures/seed.js';

export { APP_ID, SHARED, PUBLIC, AUTHORIZED_EMAIL } from '../fixtures/seed.js';

/** FullCalendar minimale: registra le opzioni e risolve gli eventi tramite la callback `events`. */
export class FakeCalendar {
    constructor(el, options) {
        this.el = el;
        this.options = options;
        this.renderedEvents = [];
        this.view = options.initialView;
        this.calls = [];
        FakeCalendar.instances.push(this);
    }
    render() { this.calls.push(['render']); this._fetch(); }
    refetchEvents() { this.calls.push(['refetchEvents']); this._fetch(); }
    updateSize() { this.calls.push(['updateSize']); }
    gotoDate(date) { this.calls.push(['gotoDate', new Date(date).toISOString()]); this.date = new Date(date); }
    changeView(view) { this.calls.push(['changeView', view]); this.view = view; }
    setOption(name, value) { this.calls.push(['setOption', name]); this.options[name] = value; }
    today() { this.calls.push(['today']); }
    getEvents() { return this.renderedEvents; }
    /** Simula il click su un evento del calendario. */
    clickEvent(id) {
        const ev = this.renderedEvents.find(e => e.id === id);
        if (!ev) throw new Error(`Evento ${id} non presente nel calendario`);
        this.options.eventClick({ event: { id: ev.id, title: ev.title, start: new Date(ev.start), end: ev.end ? new Date(ev.end) : null, extendedProps: ev.extendedProps || {} } });
    }
    _fetch() {
        const fn = this.options.events;
        if (typeof fn === 'function') fn({}, events => { this.renderedEvents = events; });
    }
}
FakeCalendar.instances = [];

function buildInstrumentedScript() {
    const source = getModuleScript();
    const ast = parseModuleScript();
    const imports = ast.body.filter(n => n.type === 'ImportDeclaration');
    let result = '';
    let cursor = 0;
    for (const node of imports) {
        const names = node.specifiers.map(s => s.local.name).join(', ');
        result += source.slice(cursor, node.start) + `const { ${names} } = window.__firebaseModule;`;
        cursor = node.end;
    }
    result += source.slice(cursor);
    const fnNames = topLevelFunctionNames();
    const bridge = `
;window.__app = {
    get appState() { return appState; },
    set appState(v) { appState = v; },
    get calendar() { return calendarInstance; },
    get authGateReady() { return authGateReady; },
    get userId() { return userId; },
    get pendingBackupData() { return pendingBackupData; },
    set pendingBackupData(v) { pendingBackupData = v; },
    fn: { ${fnNames.join(', ')} }
};`;
    return `(() => {\n"use strict";\n${result}\n${bridge}\n})();`;
}

let instrumentedScript = null;

/**
 * Avvia l'applicazione in jsdom.
 * @param {object} [options]
 * @param {Record<string, object>} [options.docs] documenti Firestore iniziali (percorso → dati)
 * @param {object|null} [options.popupUser] utente restituito dal popup Google
 * @param {(window: Window) => void} [options.beforeScript] hook eseguito prima dello script dell'app
 * @param {number} [options.width] larghezza viewport simulata
 * @param {string} [options.anonymousError] fa fallire l'accesso anonimo iniziale
 * @param {string} [options.initError] fa fallire initializeApp
 * @param {boolean} [options.waitForAuth=true] attende che il gate di autenticazione sia pronto
 */
export async function bootApp(options = {}) {
    firebaseMock.mockControl.reset({ docs: options.docs || {}, popupUser: options.popupUser ?? null, anonymousError: options.anonymousError ?? null, initError: options.initError ?? null });
    FakeCalendar.instances = [];
    const html = readIndexHtml().replace(/<script[\s\S]*?<\/script>/g, '');
    const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
    const { window } = dom;
    if (options.width) Object.defineProperty(window, 'innerWidth', { value: options.width, configurable: true });
    window.__firebaseModule = firebaseMock;
    window.FullCalendar = { Calendar: FakeCalendar };
    window.structuredClone = window.structuredClone || (v => JSON.parse(JSON.stringify(v)));
    window.fetch = options.fetch || (async () => { throw new Error('fetch non configurato nel test'); });
    window.URL.createObjectURL = () => 'blob:mock';
    window.URL.revokeObjectURL = () => {};
    window.HTMLElement.prototype.scrollIntoView = function () {};
    window.console.error = options.silenceErrors === false ? console.error : () => {};
    window.console.warn = () => {};
    window.console.log = () => {};
    options.beforeScript?.(window);
    if (!instrumentedScript) instrumentedScript = buildInstrumentedScript();
    window.eval(instrumentedScript);
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    const app = createAppDriver(dom);
    if (options.waitForAuth !== false) await app.waitFor(() => window.__app.authGateReady, 'authGateReady');
    await app.flush();
    return app;
}

function createAppDriver(dom) {
    const { window } = dom;
    const document = window.document;
    const driver = {
        dom,
        window,
        document,
        mock: firebaseMock.mockControl,
        get state() { return window.__app.appState; },
        get fn() { return window.__app.fn; },
        get calendar() { return window.__app.calendar; },
        $: (sel) => document.querySelector(sel),
        $$: (sel) => [...document.querySelectorAll(sel)],
        byId: (id) => document.getElementById(id),
        isHidden: (id) => document.getElementById(id).classList.contains('hidden'),
        text: (id) => document.getElementById(id).textContent.replace(/\s+/g, ' ').trim(),
        toast: () => document.getElementById('toast-message').textContent,
        async flush(rounds = 8) {
            for (let i = 0; i < rounds; i++) await new Promise(r => setTimeout(r, 0));
        },
        async waitFor(predicate, label = 'condizione', timeout = 3000) {
            const start = Date.now();
            while (Date.now() - start < timeout) {
                if (predicate()) return;
                await new Promise(r => setTimeout(r, 5));
            }
            throw new Error(`Timeout in attesa di: ${label}`);
        },
        setValue(id, value) {
            const el = document.getElementById(id);
            el.value = value;
            el.dispatchEvent(new window.Event('input', { bubbles: true }));
            el.dispatchEvent(new window.Event('change', { bubbles: true }));
        },
        async submit(formId) {
            const form = document.getElementById(formId);
            const handlerName = form.getAttribute('onsubmit').match(/^(\w+)\(/)[1];
            const event = new window.Event('submit', { cancelable: true });
            await window[handlerName](event);
            await driver.flush();
        },
        /** Esegue il login come utente autorizzato e chiude il report di sincronizzazione automatica. */
        async login(email = AUTHORIZED_EMAIL) {
            driver.mock.setPopupUser({ email, uid: `uid-${email}` });
            await window.handleGoogleLogin();
            await driver.waitFor(() => window.__app.appState.isLoggedIn, 'login');
            await driver.waitFor(() => document.getElementById('sync-modal-title').textContent === 'Sincronizzazione completata', 'sync automatica');
            await new Promise(r => setTimeout(r, 120)); // initCalendar è differito di 100ms
            await driver.flush();
        },
        async confirm() {
            document.getElementById('confirm-ok-btn').click();
            await driver.flush(15);
        },
        close() { driver.mock.detachAll(); window.close(); }
    };
    return driver;
}
