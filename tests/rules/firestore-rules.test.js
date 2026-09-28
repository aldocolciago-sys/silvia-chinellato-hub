/**
 * Test delle regole di sicurezza Firestore (firestore.rules) sull'emulatore.
 * Avvio: npm run test:rules (avvia e chiude l'emulatore da solo).
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs } from 'firebase/firestore';
import { readIndexHtml } from '../support/app-source.js';

const APP = 'silvia-chinellato-app';
const PUBLIC = `artifacts/${APP}/public/data`;
const SHARED = `artifacts/${APP}/shared/data`;
const REQUESTS = `artifacts/${APP}/requests`;

let env;
beforeAll(async () => {
    const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8085').split(':');
    env = await initializeTestEnvironment({
        projectId: 'demo-silvia-rules',
        firestore: { rules: readFileSync('firestore.rules', 'utf8'), host, port: Number(port) }
    });
});
afterAll(async () => { await env?.cleanup(); });
beforeEach(async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
        const db = ctx.firestore();
        await setDoc(doc(db, `${PUBLIC}/news_list/n1`), { id: 'n1', title: 'News' });
        await setDoc(doc(db, `${SHARED}/patients_list/p1`), { id: 'p1', name: 'Mario Rossi' });
        await setDoc(doc(db, `${REQUESTS}/r1`), validRequest());
        await setDoc(doc(db, `artifacts/${APP}/users/uid-silvia/patients_list/p1`), { id: 'p1' });
    });
});

// Utenti di prova
const visitor = () => env.unauthenticatedContext().firestore();
const anonymous = () => env.authenticatedContext('anon-1', { firebase: { sign_in_provider: 'anonymous' } }).firestore();
const stranger = () => env.authenticatedContext('uid-stranger', { email: 'qualcuno@gmail.com', email_verified: true }).firestore();
const unverifiedAdmin = () => env.authenticatedContext('uid-silvia', { email: 'silviachine@gmail.com', email_verified: false }).firestore();
const silvia = () => env.authenticatedContext('uid-silvia', { email: 'silviachine@gmail.com', email_verified: true }).firestore();
const aldo = () => env.authenticatedContext('uid-aldo', { email: 'aldo.colciago@gmail.com', email_verified: true }).firestore();

const NON_ADMINS = { visitatore: visitor, 'utente anonimo': anonymous, 'account non autorizzato': stranger, 'amministratore con email non verificata': unverifiedAdmin };
const ADMINS = { Silvia: silvia, Aldo: aldo };

function validRequest(extra = {}) {
    return { name: 'Anna Bianchi', phone: '333 1234567', email: 'anna@example.com', treatment: 'osteopatia', preferredDays: 'martedì o giovedì', preferredTime: 'pomeriggio', message: 'Mal di schiena da due settimane', consent: true, createdAt: '2030-03-04T10:00:00.000Z', status: 'new', ...extra };
}

/** Tutte le collezioni e i documenti condivisi usati da index.html. */
function sharedPathsUsedByApp() {
    const html = readIndexHtml();
    const paths = new Set();
    for (const m of html.matchAll(/sharedCollection\('([a-z_]+)'\)/g)) paths.add(`${SHARED}/${m[1]}/test-doc`);
    for (const m of html.matchAll(/sharedDocument\('([a-z_]+)',\s*'([a-z_-]+)'\)/g)) paths.add(`${SHARED}/${m[1]}/${m[2]}`);
    for (const m of html.matchAll(/sharedDocument\('([a-z_]+)',\s*[a-zA-Z`]/g)) paths.add(`${SHARED}/${m[1]}/test-doc`);
    return [...paths].sort();
}
const PUBLIC_COLLECTIONS = [...new Set([...readIndexHtml().matchAll(/'public',\s*'data',\s*'([a-z_]+)'/g)].map(m => m[1]))].sort();

describe('dati pubblici (sito)', () => {
    it('le collezioni pubbliche usate dal sito sono quelle attese', () => {
        expect(PUBLIC_COLLECTIONS).toEqual(['centers_list', 'news_list', 'preparations_list', 'treatments_list']);
    });

    for (const [who, db] of Object.entries({ ...NON_ADMINS, ...ADMINS })) {
        it(`${who}: può leggere`, async () => {
            await assertSucceeds(getDoc(doc(db(), `${PUBLIC}/news_list/n1`)));
            await assertSucceeds(getDocs(collection(db(), `${PUBLIC}/treatments_list`)));
        });
    }
    for (const [who, db] of Object.entries(NON_ADMINS)) {
        it(`${who}: non può scrivere né cancellare`, async () => {
            for (const name of PUBLIC_COLLECTIONS) await assertFails(setDoc(doc(db(), `${PUBLIC}/${name}/x`), { title: 'vandalismo' }));
            await assertFails(deleteDoc(doc(db(), `${PUBLIC}/news_list/n1`)));
        });
    }
    for (const [who, db] of Object.entries(ADMINS)) {
        it(`${who}: può scrivere e cancellare`, async () => {
            for (const name of PUBLIC_COLLECTIONS) await assertSucceeds(setDoc(doc(db(), `${PUBLIC}/${name}/x`), { title: 'ok' }));
            await assertSucceeds(deleteDoc(doc(db(), `${PUBLIC}/news_list/n1`)));
        });
    }
});

describe('dati condivisi (pazienti, agenda, compensi, impostazioni)', () => {
    const paths = sharedPathsUsedByApp();

    it('copre tutte le collezioni usate dall\'app', () => {
        expect(paths).toEqual([
            `${SHARED}/_meta/test-doc`, `${SHARED}/centers_list/test-doc`, `${SHARED}/clinical_sessions/test-doc`,
            `${SHARED}/manual_revenue/test-doc`, `${SHARED}/patients_list/test-doc`,
            `${SHARED}/settings/agenda`, `${SHARED}/settings/finance`, `${SHARED}/settings/messaging`,
            `${SHARED}/studio_events/test-doc`, `${SHARED}/tax_profile/default`
        ]);
    });

    for (const [who, db] of Object.entries(NON_ADMINS)) {
        it(`${who}: nessun accesso`, async () => {
            await assertFails(getDoc(doc(db(), `${SHARED}/patients_list/p1`)));
            await assertFails(getDocs(collection(db(), `${SHARED}/patients_list`)));
            for (const path of paths) await assertFails(setDoc(doc(db(), path), { x: 1 }));
        });
    }
    for (const [who, db] of Object.entries(ADMINS)) {
        it(`${who}: lettura e scrittura su tutte le collezioni`, async () => {
            await assertSucceeds(getDocs(collection(db(), `${SHARED}/patients_list`)));
            for (const path of paths) {
                await assertSucceeds(setDoc(doc(db(), path), { x: 1 }, { merge: true }));
                await assertSucceeds(getDoc(doc(db(), path)));
            }
            await assertSucceeds(deleteDoc(doc(db(), `${SHARED}/patients_list/p1`)));
        });
    }
});

describe('dati legacy per utente', () => {
    it('solo l\'amministratore proprietario', async () => {
        await assertSucceeds(getDoc(doc(silvia(), `artifacts/${APP}/users/uid-silvia/patients_list/p1`)));
        await assertFails(getDoc(doc(aldo(), `artifacts/${APP}/users/uid-silvia/patients_list/p1`)));
        await assertFails(getDoc(doc(unverifiedAdmin(), `artifacts/${APP}/users/uid-silvia/patients_list/p1`)));
        await assertFails(getDoc(doc(env.authenticatedContext('uid-silvia', { firebase: { sign_in_provider: 'anonymous' } }).firestore(), `artifacts/${APP}/users/uid-silvia/patients_list/p1`)));
    });
});

describe('richieste di appuntamento dal sito', () => {
    for (const [who, db] of Object.entries({ visitatore: visitor, 'utente anonimo': anonymous })) {
        it(`${who}: può inviare una richiesta valida`, async () => {
            await assertSucceeds(setDoc(doc(db(), `${REQUESTS}/nuova`), validRequest()));
            const { email, treatment, preferredDays, preferredTime, message, ...minimal } = validRequest();
            await assertSucceeds(setDoc(doc(db(), `${REQUESTS}/minima`), minimal));
        });
        it(`${who}: non può leggere, modificare o cancellare le richieste`, async () => {
            await assertFails(getDoc(doc(db(), `${REQUESTS}/r1`)));
            await assertFails(getDocs(collection(db(), REQUESTS)));
            await assertFails(updateDoc(doc(db(), `${REQUESTS}/r1`), { status: 'archived' }));
            await assertFails(setDoc(doc(db(), `${REQUESTS}/r1`), validRequest({ name: 'Sovrascritta' })));
            await assertFails(deleteDoc(doc(db(), `${REQUESTS}/r1`)));
        });
    }

    it.each([
        ['un campo non previsto', validRequest({ admin: true })],
        ['senza consenso', validRequest({ consent: false })],
        ['stato diverso da "new"', validRequest({ status: 'archived' })],
        ['nome troppo corto', validRequest({ name: 'A' })],
        ['nome troppo lungo', validRequest({ name: 'x'.repeat(101) })],
        ['telefono troppo corto', validRequest({ phone: '123' })],
        ['messaggio troppo lungo', validRequest({ message: 'x'.repeat(1001) })],
        ['trattamento diverso dall\'osteopatia in studio', validRequest({ treatment: 'idrocolonterapia' })],
        ['email non testuale', validRequest({ email: 42 })]
    ])('rifiuta una richiesta con %s', async (_, data) => {
        await assertFails(setDoc(doc(visitor(), `${REQUESTS}/x`), data));
    });

    it('rifiuta una richiesta senza telefono', async () => {
        const { phone, ...data } = validRequest();
        await assertFails(setDoc(doc(visitor(), `${REQUESTS}/x`), data));
    });

    for (const [who, db] of Object.entries(ADMINS)) {
        it(`${who}: legge, archivia e cancella le richieste`, async () => {
            await assertSucceeds(getDocs(collection(db(), REQUESTS)));
            await assertSucceeds(updateDoc(doc(db(), `${REQUESTS}/r1`), { status: 'archived' }));
            await assertSucceeds(deleteDoc(doc(db(), `${REQUESTS}/r1`)));
        });
    }
    it('un account non autorizzato non legge le richieste', async () => {
        await assertFails(getDocs(collection(stranger(), REQUESTS)));
    });
});

describe('tutto il resto è negato', () => {
    it.each([
        ['un percorso sconosciuto', 'altro/doc'],
        ['una sottocollezione non prevista dei dati condivisi', `${SHARED}/patients_list/p1/segreti/x`],
        ['la radice di un\'altra app', 'artifacts/altra-app/shared/data/patients_list/p1']
    ])('%s (anche per gli amministratori, salvo percorsi previsti)', async (_, path) => {
        await assertFails(setDoc(doc(stranger(), path), { x: 1 }));
        if (!path.startsWith('artifacts/altra-app')) await assertFails(setDoc(doc(silvia(), path), { x: 1 }));
    });
});
