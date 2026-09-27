# Ambiente di test – Silvia Chinellato Hub

L'applicazione è composta da:

- **`index.html`**: sito pubblico + area riservata (agenda, pazienti, compensi, backup), con tutta la logica in un unico `<script type="module">` che usa Firebase (Auth + Firestore), FullCalendar e Tailwind da CDN;
- **`api/ical.js`**: funzione serverless Vercel che fa da proxy per scaricare i calendari iCal dei poliambulatori.

L'ambiente di test **non modifica il codice dell'applicazione**: legge `index.html` e ne esegue/estrae la logica così com'è.

## Comandi

```bash
npm install                 # una volta
npx playwright install chromium   # una volta, solo per gli E2E (non serve se il browser è già presente)

npm run test:unit           # unit + integrazione (Vitest, ~15 s)
npm run test:coverage       # come sopra con copertura di api/ (soglia 95%)
npm run test:e2e            # end-to-end nel browser (Playwright, desktop + mobile)
npm run test:e2e:ui         # E2E in modalità interattiva
npm test                    # unit + E2E
npm run serve               # avvia il sito in locale su http://127.0.0.1:4173 (con /api/ical funzionante)
```

## Livelli di test

| Livello | Cartella | Strumento | Cosa verifica |
|---|---|---|---|
| Unit | `tests/unit` | Vitest | `api/ical.js` (CORS, validazione, errori HTTP, timeout 15 s, normalizzazione URL Google) e le funzioni pure di `index.html`: parsing date iCal, blocchi di note cliniche, abbinamento nomi pazienti (Levenshtein), calcoli finanziari, validazione backup, link di richiamo WhatsApp/email, report di sincronizzazione. Include controlli statici su `index.html` (handler `onclick` definiti, id referenziati esistenti, modali nascoste, asset presenti) e su `vercel.json`. |
| Integrazione | `tests/integration` | Vitest + jsdom | L'**intero script dell'app** eseguito in jsdom con Firebase simulato: login/logout e autorizzazioni, sito pubblico, agenda e conflitti, eventi non clinici ed esterni, anagrafica, unione duplicati, richiami, sincronizzazione iCal (aggiunte, modifiche, cancellazioni con decisione obbligatoria, proxy di riserva), dashboard compensi e simulatore fiscale, backup/ripristino, gestione contenuti, migrazioni dati. Più test HTTP reali di `/api/ical` su server locali. |
| End-to-end | `tests/e2e` | Playwright (Chromium desktop 1366×900 + Pixel 7) | Flussi utente reali nel browser: navigazione pubblica, accesso, creazione/modifica/eliminazione appuntamenti in FullCalendar, sincronizzazione iCal **passando dalla vera funzione `/api/ical`**, pazienti, compensi, news, export/import backup (download reale), navigazione mobile, accessibilità (axe-core, WCAG 2.1 AA). |

## Come funzionano i doppi di test

- **Firebase** → `tests/mocks/firebase/firebase-mock-core.js`: implementazione in memoria di `initializeApp`, Auth (anonimo, popup Google, signOut, `onAuthStateChanged`) e Firestore (`doc`, `collection`, `getDoc(s)`, `setDoc` con `merge`, `deleteDoc`, `onSnapshot` realtime). Lo stesso modulo è usato in jsdom e nel browser (dove sostituisce gli URL `https://www.gstatic.com/firebasejs/...`). Dai test si controlla tramite `window.__firebaseMock` (`seed`, `get`, `list`, `failNext` per simulare errori di permesso, `setPopupUser`, …).
- **Dati di esempio** → `tests/fixtures/seed.js` (`seedDocs`, `center`, `patient`, `studioEvent`) e `tests/fixtures/ical.js`.
- **jsdom** → `tests/support/jsdom-app.js` (`bootApp`) carica `index.html`, sostituisce gli `import` con il mock, espone `appState` e le funzioni interne in `window.__app`, e fornisce un FullCalendar minimale. Helper: `login()`, `submit(formId)`, `confirm()`, `setValue()`.
- **Estrazione funzioni** → `tests/support/app-source.js` (`loadFunctions([...])`) analizza lo script con acorn ed estrae le funzioni per testarle isolatamente.
- **Browser offline** → `tests/e2e/fixtures.js` intercetta tutte le richieste esterne: Tailwind Play CDN è sostituito da CSS compilato con la stessa configurazione (`tests/support/build-tailwind.mjs`, eseguito in `global-setup`), FullCalendar è servito da `node_modules` (stessa versione 6.1.8), font/icone restituiscono risposte vuote e ogni altra richiesta è bloccata e segnalata.
- **Server locale** → `tests/support/server.mjs` replica Vercel: file statici + `/api/ical` eseguito dalla funzione reale + calendari di prova in `/__fixtures__/` (anche modificabili via `PUT /__fixtures__/dynamic/<chiave>.ics`).

Tutti i test girano con fuso `Europe/Rome` e locale `it-IT`.

## Problemi noti documentati dai test

I test marcati `it.fails` (Vitest) o `test.fail()` (Playwright) descrivono il **comportamento corretto atteso** e oggi falliscono perché l'applicazione ha un difetto. La suite resta verde; quando un difetto viene corretto il test corrispondente diventa "inaspettatamente riuscito" e segnala di rimuovere il marcatore.

| Area | Problema | Test |
|---|---|---|
| Sync iCal | Orari con `TZID` (o senza `Z`) interpretati come UTC: appuntamenti spostati di 1–2 ore | `ical-parsing`, `ical-sync` |
| Sync iCal | Se il download di un calendario fallisce, **tutti** i suoi eventi già importati vengono proposti come "rimossi alla fonte" | `ical-sync` |
| Sync iCal | Il badge "Errore" viene subito sostituito dal report finale, che mostra la sede come "Nessuna variazione" | `ical-sync` |
| Sync iCal | Righe ICS ripiegate (RFC 5545) e caratteri con escape (`\,`) non gestiti | `ical-sync` |
| Agenda | Se Firestore rifiuta il salvataggio, l'appuntamento resta comunque nello stato locale | `appointments` |
| Agenda | Nessuna validazione: si può salvare un appuntamento che finisce prima di iniziare | `appointments` |
| Contenuti | Errori di salvataggio di sedi/trattamenti/news/guide ignorati: compare comunque "salvato" | `content-admin` |
| Sicurezza | Contenuti pubblici inseriti con `innerHTML` senza escape (XSS memorizzato) | `public-site` |
| Sicurezza | `/api/ical` scarica qualunque URL, anche host interni (SSRF) e accetta metodi diversi da GET | `api-ical` |
| Dati | Un errore in una migrazione una-tantum impedisce il caricamento di pazienti e appuntamenti | `migrations` |
| Accessibilità | Etichette del modulo appuntamento non associate ai campi; contrasto 4.45:1 del badge data news | `accessibility` |

## Aggiungere un test

- Logica pura → `tests/unit/*.test.js` con `loadFunctions(['nomeFunzione'], { appState })`.
- Flusso applicativo veloce → `tests/integration/*.test.js` con `bootApp({ docs: seedDocs({...}) })` e `await app.login()`.
- Flusso nel browser → `tests/e2e/*.spec.js` importando `test`, `expect`, `loginViaUi` da `./fixtures.js`; per i dati usare `test.use({ firebaseSeed: { docs: seedDocs({...}), popupUser } })`.
