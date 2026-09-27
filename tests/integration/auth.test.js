import { describe, it, expect, afterEach } from 'vitest';
import { bootApp } from '../support/jsdom-app.js';
import { seedDocs, AUTHORIZED_EMAIL, SECOND_AUTHORIZED_EMAIL, UNAUTHORIZED_EMAIL } from '../fixtures/seed.js';

let app;
afterEach(() => app?.close());

describe('avvio e autenticazione', () => {
    it('all’avvio mostra la vista pubblica con sessione anonima e stato "Connesso"', async () => {
        app = await bootApp();
        expect(app.isHidden('public-view')).toBe(false);
        expect(app.isHidden('private-view')).toBe(true);
        expect(app.text('public-firebase-text')).toBe('Connesso');
        expect(app.byId('public-firebase-dot').className).toContain('bg-emerald-500');
        expect(app.mock.currentUser()).toMatchObject({ isAnonymous: true });
        expect(app.state.isLoggedIn).toBe(false);
    });

    it('non ripristina sessioni precedenti: persistenza in memoria e signOut all’avvio', async () => {
        app = await bootApp();
        const ops = app.mock.calls().map(c => c.op);
        expect(ops.indexOf('setPersistence')).toBeLessThan(ops.indexOf('signOut'));
        expect(ops.indexOf('signOut')).toBeLessThan(ops.indexOf('signInAnonymously'));
    });

    it('mostra "Accesso non disponibile" se l’accesso anonimo fallisce e blocca il login', async () => {
        app = await bootApp({ anonymousError: 'network', waitForAuth: false });
        await app.waitFor(() => app.text('public-firebase-text') === 'Accesso non disponibile', 'stato errore');
        expect(app.byId('public-firebase-dot').className).toContain('bg-rose-500');
        expect(app.window.__app.authGateReady).toBe(false);
        app.mock.setPopupUser({ email: AUTHORIZED_EMAIL });
        await app.window.handleGoogleLogin();
        expect(app.toast()).toBe('Autenticazione non ancora disponibile.');
        expect(app.state.isLoggedIn).toBe(false);
    });

    it.each([AUTHORIZED_EMAIL, SECOND_AUTHORIZED_EMAIL])('consente l’accesso a %s e apre l’area riservata', async (email) => {
        app = await bootApp({ docs: seedDocs() });
        await app.login(email);
        expect(app.isHidden('private-view')).toBe(false);
        expect(app.isHidden('public-view')).toBe(true);
        expect(app.text('logged-user-email-display')).toBe(email);
        expect(app.state.currentUserEmail).toBe(email);
        expect(app.document.body.classList.contains('mobile-admin-active')).toBe(true);
        expect(app.calendar).toBeTruthy();
    });

    it('confronta l’email autorizzata senza distinguere maiuscole e minuscole', async () => {
        app = await bootApp({ docs: seedDocs() });
        app.mock.setPopupUser({ email: 'SilviaChine@Gmail.com', uid: `uid-${AUTHORIZED_EMAIL}` });
        await app.window.handleGoogleLogin();
        await app.waitFor(() => app.state.isLoggedIn, 'login');
        expect(app.state.currentUserEmail).toBe(AUTHORIZED_EMAIL);
    });

    it('esegue la sincronizzazione automatica al login e la mostra nel report', async () => {
        app = await bootApp({ docs: seedDocs() });
        await app.login();
        expect(app.isHidden('sync-report-modal')).toBe(false);
        expect(app.text('sync-report-content')).toContain('Nessun link iCal configurato');
    });

    it('rifiuta un’email non autorizzata, esegue signOut e resta sulla vista pubblica', async () => {
        app = await bootApp();
        app.mock.setPopupUser({ email: UNAUTHORIZED_EMAIL });
        app.window.openLoginModal();
        await app.window.handleGoogleLogin();
        await app.flush();
        expect(app.toast()).toBe(`Email ${UNAUTHORIZED_EMAIL} non autorizzata.`);
        expect(app.state.isLoggedIn).toBe(false);
        expect(app.isHidden('private-view')).toBe(true);
        expect(app.mock.currentUser()).toBeNull();
        expect(app.isHidden('login-modal')).toBe(false);
    });

    it('gestisce la chiusura del popup Google con un messaggio d’errore', async () => {
        app = await bootApp();
        app.mock.setPopupError('popup chiuso');
        await app.window.handleGoogleLogin();
        expect(app.toast()).toBe("Errore durante l'accesso Google.");
        expect(app.isHidden('public-view')).toBe(false);
    });

    it('il logout torna alla vista pubblica e interrompe la sincronizzazione realtime', async () => {
        app = await bootApp({ docs: seedDocs() });
        await app.login();
        expect(app.mock.listenerCount()).toBeGreaterThan(0);
        await app.window.handleLogout();
        await app.flush();
        expect(app.isHidden('public-view')).toBe(false);
        expect(app.isHidden('private-view')).toBe(true);
        expect(app.state.isLoggedIn).toBe(false);
        expect(app.mock.listenerCount()).toBe(0);
        expect(app.toast()).toBe('Disconnesso');
    });

    it('un cambio di utente verso un account non autorizzato chiude l’area riservata', async () => {
        app = await bootApp({ docs: seedDocs() });
        await app.login();
        app.mock.setPopupUser({ email: UNAUTHORIZED_EMAIL });
        await app.window.__firebaseModule.signInWithPopup();
        await app.waitFor(() => !app.state.isLoggedIn, 'uscita');
        expect(app.isHidden('private-view')).toBe(true);
    });

    it('la sincronizzazione manuale richiede il login', async () => {
        app = await bootApp();
        await app.window.triggerIcalSync();
        expect(app.isHidden('login-modal')).toBe(false);
        expect(app.toast()).toBe('Accedi con un account autorizzato prima di sincronizzare.');
    });

    it('le operazioni amministrative sono bloccate senza login', async () => {
        app = await bootApp();
        app.window.exportCompleteBackup();
        expect(app.toast()).toBe('Accesso autorizzato necessario.');
        await app.window.handleManualRevenueSubmit(new app.window.Event('submit', { cancelable: true }));
        expect(app.toast()).toBe('Accesso autorizzato necessario.');
        await app.window.handleTaxProfileSubmit(new app.window.Event('submit', { cancelable: true }));
        expect(app.toast()).toBe('Accesso autorizzato necessario.');
    });

    it('apre e chiude la finestra di login', async () => {
        app = await bootApp();
        app.window.openLoginModal();
        expect(app.isHidden('login-modal')).toBe(false);
        app.window.closeLoginModal();
        expect(app.isHidden('login-modal')).toBe(true);
    });
});

describe('avvio senza Firebase', () => {
    it('mostra "Non disponibile" e i contenuti predefiniti se initializeApp fallisce', async () => {
        app = await bootApp({ initError: 'config non valida', waitForAuth: false });
        expect(app.text('public-firebase-text')).toBe('Non disponibile');
        expect(app.window.__app.userId).toBe('offline-user');
        expect(app.$$('#public-treatments-grid > div').length).toBe(3);
        expect(app.$$('#public-centers-grid > div').length).toBe(2);
        expect(app.isHidden('public-view')).toBe(false);
    });
});
