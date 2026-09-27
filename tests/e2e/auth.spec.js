import { test, expect, openSite, loginViaUi, isMobile, firestore } from './fixtures.js';
import { seedDocs, UNAUTHORIZED_EMAIL, SECOND_AUTHORIZED_EMAIL } from '../fixtures/seed.js';

test.describe('area riservata: accesso', () => {
    test.use({ firebaseSeed: { docs: seedDocs(), popupUser: { email: 'silviachine@gmail.com', uid: 'uid-silviachine@gmail.com' } } });

    test('accesso con account autorizzato e sincronizzazione automatica', async ({ page }) => {
        await loginViaUi(page, { closeReport: false });
        await expect(page.locator('#sync-report-content')).toContainText('Nessun link iCal configurato');
        await page.locator('#sync-modal-footer button').click();
        await expect(page.locator('#logged-user-email-display')).toContainText('silviachine@gmail.com');
        await expect(page.locator('#firebase-text')).toHaveText('Connesso');
        await expect(page.locator('#calendar.fc')).toBeVisible();
        await expect(page.locator('#toast-message')).toHaveText('Accesso effettuato con successo!');
    });

    test('la chiusura della finestra di login la nasconde', async ({ page }) => {
        await openSite(page);
        await page.getByRole('button', { name: 'Area Riservata' }).click();
        await page.locator('#login-modal button:has(.fa-xmark)').click();
        await expect(page.locator('#login-modal')).toBeHidden();
    });

    test('uscita dall’area riservata', async ({ page }) => {
        await loginViaUi(page);
        if (isMobile(page)) {
            await page.locator('#mobile-admin-nav').getByRole('button', { name: 'Altro' }).click();
            await page.locator('#mobile-admin-more').getByRole('button', { name: 'Esci' }).click();
        } else {
            await page.getByTitle('Esci').click();
        }
        await expect(page.locator('#public-view')).toBeVisible();
        await expect(page.locator('#private-view')).toBeHidden();
        await expect(page.locator('#toast-message')).toHaveText('Disconnesso');
    });

    test('ricaricando la pagina la sessione amministrativa non viene mantenuta', async ({ page }) => {
        await loginViaUi(page);
        await page.reload();
        await expect(page.locator('#public-firebase-text')).toHaveText('Connesso');
        await expect(page.locator('#private-view')).toBeHidden();
        await expect(page.locator('#public-view')).toBeVisible();
    });
});

test.describe('area riservata: accesso negato', () => {
    test.use({ firebaseSeed: { docs: {}, popupUser: { email: UNAUTHORIZED_EMAIL } } });

    test('un account non autorizzato viene respinto', async ({ page }) => {
        await openSite(page);
        await page.getByRole('button', { name: 'Area Riservata' }).click();
        await page.getByRole('button', { name: 'Accedi con Google' }).click();
        await expect(page.locator('#toast-message')).toHaveText(`Email ${UNAUTHORIZED_EMAIL} non autorizzata.`);
        await expect(page.locator('#private-view')).toBeHidden();
        expect(await page.evaluate(() => window.__firebaseMock.currentUser())).toBeNull();
    });

    test('la chiusura del popup Google mostra un errore', async ({ page }) => {
        await openSite(page);
        await firestore(page).setPopupUser(null);
        await page.getByRole('button', { name: 'Area Riservata' }).click();
        await page.getByRole('button', { name: 'Accedi con Google' }).click();
        await expect(page.locator('#toast-message')).toHaveText("Errore durante l'accesso Google.");
    });
});

test.describe('area riservata: secondo amministratore', () => {
    test.use({ firebaseSeed: { docs: seedDocs(), popupUser: { email: SECOND_AUTHORIZED_EMAIL, uid: `uid-${SECOND_AUTHORIZED_EMAIL}` } } });

    test('anche il secondo account autorizzato accede', async ({ page }) => {
        await loginViaUi(page);
        await expect(page.locator('#logged-user-email-display')).toContainText(SECOND_AUTHORIZED_EMAIL);
    });
});
