import { test, expect, openSite, isMobile } from './fixtures.js';
import { seedDocs, center } from '../fixtures/seed.js';

test.describe('sito pubblico', () => {
    test('si carica senza errori JavaScript né richieste esterne impreviste', async ({ page, pageErrors, blockedRequests }) => {
        await openSite(page);
        await expect(page).toHaveTitle('Silvia Chinellato | Osteopata & Idrocolonterapia');
        await expect(page.getByRole('heading', { level: 1, name: 'Silvia Chinellato' })).toBeVisible();
        expect(pageErrors.map(e => e.message)).toEqual([]);
        expect(blockedRequests).toEqual([]);
    });

    test('mostra tutte le sezioni con i contenuti predefiniti', async ({ page }) => {
        await openSite(page);
        for (const id of ['profilo-pubblica', 'filosofia-pubblica', 'trattamenti-pubblica', 'poliambulatori-pubblica', 'news-pubblica', 'preparazione-pubblica', 'contatti-pubblica']) {
            await expect(page.locator(`#${id}`)).toBeAttached();
        }
        await expect(page.locator('#public-treatments-grid > div')).toHaveCount(3);
        await expect(page.locator('#public-centers-grid > div')).toHaveCount(2);
        await expect(page.locator('#public-news-grid > div')).toHaveCount(1);
        await expect(page.locator('#public-preparations-grid > div')).toHaveCount(1);
        await expect(page.locator('#private-view')).toBeHidden();
    });

    test('le immagini del profilo e del logo vengono caricate', async ({ page }) => {
        await openSite(page);
        const images = page.locator('#public-view img[src="Logo.jpeg"], #public-view img[src="Silvia Foto Profilo.jpeg"]');
        await expect(images).toHaveCount(3);
        const sizes = await images.evaluateAll(imgs => imgs.map(img => ({ src: img.getAttribute('src'), ok: img.complete && img.naturalWidth > 0 })));
        expect(sizes.every(s => s.ok), JSON.stringify(sizes)).toBe(true);
    });

    test('la navigazione porta alle sezioni', async ({ page }) => {
        await openSite(page);
        const nav = isMobile(page) ? page.locator('header .md\\:hidden') : page.locator('header nav');
        await nav.getByRole('link', { name: 'Contatti' }).click();
        await expect(page).toHaveURL(/#contatti-pubblica$/);
        await expect(page.getByRole('heading', { name: 'Entra in Contatto con Silvia' })).toBeInViewport();
    });

    test('espande e riduce una news', async ({ page }) => {
        await openSite(page);
        const button = page.locator('#news-btn-0');
        await expect(button).toHaveText(/Leggi tutto/);
        await button.click();
        await expect(button).toHaveText(/Riduci/);
        await expect(page.locator('#news-content-0')).toHaveClass(/expanded/);
        await button.click();
        await expect(button).toHaveText(/Leggi tutto/);
    });

    test.describe('con dati pubblicati', () => {
        test.use({
            firebaseSeed: {
                docs: seedDocs({
                    publicCenters: [
                        center({ id: 'a', name: 'Studio Monza', bookingUrl: 'https://prenota.example/monza' }),
                        center({ id: 'b', name: 'Sede nascosta', showPublic: false })
                    ],
                    news: [{ id: 'n1', title: 'Nuovi orari', date: '2030-09-01', content: 'Aperti anche il sabato', link: '' }]
                })
            }
        });

        test('mostra solo le sedi pubbliche con il link di prenotazione', async ({ page }) => {
            await openSite(page);
            await expect(page.locator('#public-centers-grid > div')).toHaveCount(1);
            const card = page.locator('#public-centers-grid > div').first();
            await expect(card).toContainText('Studio Monza');
            await expect(card.getByRole('link', { name: 'Prenota Online' })).toHaveAttribute('href', 'https://prenota.example/monza');
            await expect(card.getByRole('link', { name: 'Prenota Online' })).toHaveAttribute('target', '_blank');
            // i link sono pulsanti ben visibili: sfondo pieno verde e testo bianco
            const booking = card.getByRole('link', { name: 'Prenota Online' });
            await expect(booking).toHaveCSS('background-color', 'rgb(63, 94, 78)');
            await expect(booking).toHaveCSS('color', 'rgb(255, 255, 255)');
            const site = card.getByRole('link', { name: 'Sito Web' });
            await expect(site).toHaveCSS('background-color', 'rgb(244, 248, 249)');
            expect((await booking.boundingBox()).height).toBeGreaterThanOrEqual(30);
            await expect(page.locator('#public-news-grid')).toContainText('1 settembre 2030');
        });
    });

    test('non ha scroll orizzontale', async ({ page }) => {
        await openSite(page);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow).toBeLessThanOrEqual(0);
    });

    test('il numero di telefono è offuscato ma i contatti email e Instagram sono cliccabili', async ({ page }) => {
        await openSite(page);
        const contacts = page.locator('#contatti-pubblica');
        await expect(contacts.getByRole('link', { name: /Email per Appuntamenti/ })).toHaveAttribute('href', 'mailto:silviachine@gmail.com');
        await expect(contacts.getByRole('link', { name: /Instagram/ })).toHaveAttribute('href', /instagram\.com\/dott\.ssasilviachinellato/);
        await expect(contacts).toContainText('+39 333 •••••••');
    });
});
