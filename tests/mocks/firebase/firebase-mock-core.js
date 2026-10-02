/**
 * Mock in-memory dell'SDK Firebase (app, auth, firestore) usato dall'applicazione.
 *
 * Lo stesso modulo viene usato:
 *  - nei test di integrazione Vitest/jsdom (importato direttamente da Node);
 *  - nei test E2E Playwright (servito al posto di https://www.gstatic.com/firebasejs/...).
 *
 * Lo stato è unico per ogni `globalThis` e controllabile dai test tramite
 * `globalThis.__firebaseMock` (seed dei dati, utente del popup Google, errori forzati, ispezione).
 * Un eventuale seed iniziale può essere impostato prima del caricamento in
 * `globalThis.__FIREBASE_MOCK_SEED__ = { docs: { 'percorso/doc': {...} }, popupUser: {...} }`.
 */

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

function createMockState(seed = {}) {
    const state = {
        docs: new Map(),
        listeners: new Set(),
        authListeners: new Set(),
        currentUser: null,
        popupUser: seed.popupUser ?? null,
        popupError: seed.popupError ?? null,
        anonymousError: seed.anonymousError ?? null,
        initError: seed.initError ?? null,
        failures: [],
        calls: [],
        anonCounter: 0,
        autoId: 0
    };
    for (const [path, data] of Object.entries(seed.docs || {})) state.docs.set(normalizePath(path), clone(data));
    return state;
}

function normalizePath(path) {
    return String(path).split('/').filter(Boolean).join('/');
}
function parentOf(path) {
    const parts = path.split('/');
    return parts.slice(0, -1).join('/');
}

function getState() {
    if (!globalThis.__firebaseMockState) {
        globalThis.__firebaseMockState = createMockState(globalThis.__FIREBASE_MOCK_SEED__ || {});
    }
    return globalThis.__firebaseMockState;
}

function record(op, path, extra) {
    getState().calls.push({ op, path, ...(extra || {}) });
}

function maybeFail(op, path) {
    const state = getState();
    const idx = state.failures.findIndex(f => (f.op === op || f.op === '*') && (!f.path || path.startsWith(f.path) || new RegExp(f.path).test(path)));
    if (idx < 0) return;
    const failure = state.failures[idx];
    if (!failure.persistent) state.failures.splice(idx, 1);
    const err = new Error(failure.message || `Mock failure on ${op} ${path}`);
    err.code = failure.code || 'permission-denied';
    throw err;
}

const never = () => new Promise(() => {});
/** Simula la latenza di rete; dopo detachAll() le operazioni non si risolvono più (pagina chiusa). */
async function tick() {
    const state = getState();
    if (state.frozen) return never();
    await new Promise(resolve => setTimeout(resolve, 0));
    if (state.frozen || getState() !== state) return never();
}

function makeDocSnapshot(path) {
    const state = getState();
    const exists = state.docs.has(path);
    const data = exists ? clone(state.docs.get(path)) : undefined;
    const id = path.split('/').pop();
    return {
        id,
        ref: { type: 'document', path, id },
        exists: () => exists,
        data: () => clone(data)
    };
}

function makeQuerySnapshot(collectionPath) {
    const state = getState();
    const docs = [];
    for (const path of [...state.docs.keys()].sort()) {
        if (parentOf(path) === collectionPath) docs.push(makeDocSnapshot(path));
    }
    return {
        docs,
        size: docs.length,
        empty: docs.length === 0,
        forEach: (cb) => docs.forEach(cb)
    };
}

function notify(changedPath) {
    const state = getState();
    const collectionPath = parentOf(changedPath);
    for (const listener of [...state.listeners]) {
        if (listener.ref.type === 'collection' && listener.ref.path === collectionPath) {
            listener.onNext(makeQuerySnapshot(listener.ref.path));
        } else if (listener.ref.type === 'document' && listener.ref.path === changedPath) {
            listener.onNext(makeDocSnapshot(listener.ref.path));
        }
    }
}

// ---------------------------------------------------------------- firebase-app
export function initializeApp(config) {
    const state = getState();
    if (state.initError) throw new Error(state.initError);
    state.appConfig = clone(config);
    return { name: '[DEFAULT]', options: clone(config) };
}

// ---------------------------------------------------------------- firebase-auth
export const inMemoryPersistence = { type: 'NONE' };
export class GoogleAuthProvider {
    constructor() { this.providerId = 'google.com'; }
}

const authInstance = {
    get currentUser() { return getState().currentUser; }
};

function setUser(user) {
    const state = getState();
    state.currentUser = user;
    setTimeout(() => state.authListeners.forEach(cb => cb(user)), 0);
}

export function getAuth() { return authInstance; }
export async function setPersistence() { record('setPersistence', 'auth'); }
export async function signOut() {
    record('signOut', 'auth');
    setUser(null);
}
export async function signInAnonymously() {
    const state = getState();
    record('signInAnonymously', 'auth');
    if (state.anonymousError) throw new Error(state.anonymousError);
    state.anonCounter += 1;
    const user = { uid: `anon-${state.anonCounter}`, isAnonymous: true, email: null };
    state.currentUser = user;
    setTimeout(() => state.authListeners.forEach(cb => cb(user)), 0);
    return { user };
}
export async function signInWithCustomToken() {
    throw new Error('signInWithCustomToken non supportato dal mock');
}
export async function signInWithPopup() {
    const state = getState();
    record('signInWithPopup', 'auth');
    if (state.popupError) {
        const err = new Error(state.popupError);
        err.code = 'auth/popup-closed-by-user';
        throw err;
    }
    if (!state.popupUser) {
        const err = new Error('Popup chiuso');
        err.code = 'auth/popup-closed-by-user';
        throw err;
    }
    const user = { uid: state.popupUser.uid || `uid-${state.popupUser.email}`, email: state.popupUser.email, isAnonymous: false, displayName: state.popupUser.displayName || null };
    Object.defineProperty(user, 'getIdToken', { value: async () => `mock-id-token:${user.email}`, enumerable: false });
    setUser(user);
    return { user };
}
export function onAuthStateChanged(_auth, callback) {
    const state = getState();
    state.authListeners.add(callback);
    setTimeout(() => { if (state.authListeners.has(callback)) callback(state.currentUser); }, 0);
    return () => state.authListeners.delete(callback);
}

// ---------------------------------------------------------------- firebase-firestore
const dbInstance = { type: 'firestore' };
export function getFirestore() { return dbInstance; }
export function collection(_db, ...segments) {
    return { type: 'collection', path: normalizePath(segments.join('/')) };
}
export function doc(_db, ...segments) {
    const path = normalizePath(segments.join('/'));
    return { type: 'document', path, id: path.split('/').pop() };
}
export async function getDocs(ref) {
    await tick();
    record('getDocs', ref.path);
    maybeFail('getDocs', ref.path);
    return makeQuerySnapshot(ref.path);
}
export async function getDoc(ref) {
    await tick();
    record('getDoc', ref.path);
    maybeFail('getDoc', ref.path);
    return makeDocSnapshot(ref.path);
}
export async function setDoc(ref, data, options = {}) {
    await tick();
    record('setDoc', ref.path, { merge: Boolean(options.merge) });
    maybeFail('setDoc', ref.path);
    const state = getState();
    const next = options.merge && state.docs.has(ref.path)
        ? { ...state.docs.get(ref.path), ...clone(data) }
        : clone(data);
    state.docs.set(ref.path, next);
    notify(ref.path);
}
export async function addDoc(ref, data) {
    const state = getState();
    state.autoId += 1;
    const docRef = doc(null, ref.path, `auto_${state.autoId}`);
    await setDoc(docRef, data);
    return docRef;
}
export async function deleteDoc(ref) {
    await tick();
    record('deleteDoc', ref.path);
    maybeFail('deleteDoc', ref.path);
    const state = getState();
    const existed = state.docs.delete(ref.path);
    if (existed) notify(ref.path);
}
export function onSnapshot(ref, onNext, onError) {
    const state = getState();
    record('onSnapshot', ref.path);
    const listener = { ref, onNext, onError };
    try {
        maybeFail('onSnapshot', ref.path);
    } catch (err) {
        setTimeout(() => onError && onError(err), 0);
        return () => {};
    }
    state.listeners.add(listener);
    setTimeout(() => {
        if (!state.listeners.has(listener)) return;
        onNext(ref.type === 'collection' ? makeQuerySnapshot(ref.path) : makeDocSnapshot(ref.path));
    }, 0);
    return () => state.listeners.delete(listener);
}

// ---------------------------------------------------------------- API di controllo per i test
export const mockControl = {
    reset(seed = {}) {
        globalThis.__firebaseMockState = createMockState(seed);
    },
    /** Imposta/sostituisce documenti: { 'artifacts/app/shared/data/patients_list/p1': {...} } */
    seed(docs) {
        const state = getState();
        for (const [path, data] of Object.entries(docs)) {
            const normalized = normalizePath(path);
            state.docs.set(normalized, clone(data));
            notify(normalized);
        }
    },
    get(path) { return clone(getState().docs.get(normalizePath(path))); },
    has(path) { return getState().docs.has(normalizePath(path)); },
    list(collectionPath) {
        const normalized = normalizePath(collectionPath);
        return [...getState().docs.entries()].filter(([p]) => parentOf(p) === normalized).map(([p, d]) => ({ id: p.split('/').pop(), ...clone(d) }));
    },
    dump() { return Object.fromEntries([...getState().docs.entries()].map(([p, d]) => [p, clone(d)])); },
    setPopupUser(user) { getState().popupUser = user; },
    setPopupError(message) { getState().popupError = message; },
    setAnonymousError(message) { getState().anonymousError = message; },
    /** Forza il fallimento della prossima operazione (op: setDoc|getDocs|getDoc|deleteDoc|onSnapshot|'*'). */
    failNext(op, path = '', options = {}) { getState().failures.push({ op, path, ...options }); },
    clearFailures() { getState().failures = []; },
    calls() { return clone(getState().calls); },
    clearCalls() { getState().calls = []; },
    currentUser() { return clone(getState().currentUser); },
    listenerCount() { return getState().listeners.size; },
    /** Scollega tutti i listener (auth e snapshot): da chiamare prima di distruggere la pagina. */
    detachAll() { const state = getState(); state.listeners.clear(); state.authListeners.clear(); state.frozen = true; }
};

globalThis.__firebaseMock = mockControl;
