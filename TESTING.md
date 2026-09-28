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
npm run test:rules          # regole di sicurezza Firestore sull'emulatore (serve Java 21)
npm run test:e2e            # end-to-end nel browser (Playwright, desktop + mobile)
npm run test:e2e:ui         # E2E in modalità interattiva
npm test                    # unit + regole + E2E
npm run serve               # avvia il sito in locale su http://127.0.0.1:4173 (con /api/ical funzionante)
```

## Livelli di test

| Livello | Cartella | Strumento | Cosa verifica |
|---|---|---|---|
| Unit | `tests/unit` | Vitest | `api/ical.js` (CORS, validazione, errori HTTP, timeout 15 s, normalizzazione URL Google) e le funzioni pure di `index.html`: parsing date iCal, blocchi di note cliniche, abbinamento nomi pazienti (Levenshtein), calcoli finanziari, validazione backup, link di richiamo WhatsApp/email, report di sincronizzazione. Include controlli statici su `index.html` (handler `onclick` definiti, id referenziati esistenti, modali nascoste, asset presenti) e su `vercel.json`. |
| Integrazione | `tests/integration` | Vitest + jsdom | L'**intero script dell'app** eseguito in jsdom con Firebase simulato: login/logout e autorizzazioni, sito pubblico, agenda e conflitti, eventi non clinici ed esterni, anagrafica, unione duplicati, richiami, sincronizzazione iCal (aggiunte, modifiche, cancellazioni con decisione obbligatoria, proxy di riserva), dashboard compensi e simulatore fiscale, backup/ripristino, gestione contenuti, migrazioni dati. Più test HTTP reali di `/api/ical` su server locali. |
| End-to-end | `tests/e2e` | Playwright (Chromium desktop 1366×900 + Pixel 7) | Flussi utente reali nel browser. `controls.spec.js` verifica che ogni funzione sia raggiungibile (header desktop, barra inferiore e menu "Altro" su mobile), che in ogni finestra tutti i pulsanti e campi visibili siano dentro lo schermo e cliccabili, e che "Elimina"/"Modifica" funzionino per ogni tipo di elemento. Poi: navigazione pubblica, accesso, creazione/modifica/eliminazione appuntamenti in FullCalendar, sincronizzazione iCal **passando dalla vera funzione `/api/ical`**, pazienti, compensi, news, export/import backup (download reale), navigazione mobile, accessibilità (axe-core, WCAG 2.1 AA). |

## Tariffe e turni

Ogni sede ha il compenso per seduta per trattamento (`rateIdrocolonterapia`, `rateOsteopatia`); lo studio privato ha le sue tariffe in `shared/data/settings/finance`. Le sedi "non cliniche" possono essere **turni retribuiti a ore** (`isShiftCalendar`, `hourlyRate`): compenso = durata × tariffa, inclusi nei compensi e nel simulatore fiscale. La logica è in `defaultFeeForEvent` (`index.html`). Test: `tests/unit/rates.test.js`, `tests/integration/rates-shifts.test.js`, `tests/e2e/rates-shifts.spec.js`.

## Settimana tipo e tempi di spostamento

Da "Settimana tipo" (header su desktop, menu "Altro" su mobile) si impostano le fasce abituali di ogni sede e il tempo minimo per spostarsi tra due sedi (predefinito 45 minuti, 0 = disattivato), salvati in `shared/data/settings/agenda`. Le fasce compaiono come sfondo nella vista settimana/giorno; il modulo appuntamento avvisa (senza bloccare) se l'orario cade nella fascia di un'altra sede; due appuntamenti consecutivi in sedi diverse troppo vicini sono segnalati in arancione (⏱). I calendari personali non contano. Logica in `findTightTransfers`, `templateBackgroundEvents`, `templateMismatch` (`index.html`). Test: `tests/unit/weekly-template.test.js`, `tests/integration/weekly-template.test.js`, `tests/e2e/weekly-template.spec.js`.

## Promemoria di oggi e domani

"Promemoria di oggi e domani" (header su desktop, "Promemoria" nel menu "Altro" su mobile) elenca gli appuntamenti clinici di oggi non ancora iniziati e quelli di domani, esclusi turni, calendari personali e annullati. Per ciascuno apre il messaggio WhatsApp "Promemoria appuntamento" già compilato con data, ora e sede di quell'appuntamento; all'invio salva `extendedProps.reminderSentAt` sull'evento e registra il contatto del paziente. Sono evidenziati i pazienti senza telefono e gli appuntamenti senza paziente. Logica in `dayAppointments`, `todayUpcomingAppointments`, `tomorrowAppointments` e `renderReminders` (`index.html`). I test di integrazione ed E2E fissano l'orologio (lunedì 4 marzo 2030, ore 12) per risultati indipendenti dall'ora di esecuzione. Test: `tests/unit/reminders.test.js`, `tests/integration/reminders.test.js`, `tests/e2e/reminders.spec.js`.

## Valutazione pre-trattamento

Nella scheda paziente la sezione "Valutazione pre-trattamento" contiene due liste sì/no con note, data e "Verificato da Silvia": controindicazioni per l'idrocolonterapia e segni d'allarme per l'osteopatia. Le voci sono nella costante `ASSESSMENT_CHECKLISTS` (`index.html`) e i dati in `patient.assessments`. Il modulo appuntamento ha il campo "Trattamento" (salvato in `extendedProps.treatment`), proposto in automatico da titolo e sede, altrimenti dal trattamento abituale del paziente, e modificabile a mano; lo usano anche compenso e promemoria. Compare un avviso non bloccante quando la valutazione di quel trattamento manca, è incompleta o ha voci "sì" (se il trattamento non è indicato si controllano entrambe); se è tutto a posto compare una conferma in verde. Logica in `assessmentStatus` e `updateStudioAssessmentWarning`. Test: `tests/unit/assessments.test.js`, `tests/integration/assessments.test.js`, `tests/e2e/assessments.spec.js`.

## Scadenziario fiscale

Nella dashboard compensi la sezione "Scadenze fiscali" stima i versamenti dell'anno selezionato con il metodo storico: il 30 giugno si versano il saldo dell'imposta sostitutiva dell'anno precedente e il 1° acconto (40%); il 30 novembre il 2° acconto (60%). Non c'è acconto sotto 51,65 €, e fino a 257,52 € c'è un acconto unico a novembre. Le date che cadono nel fine settimana slittano al lunedì. Per i contributi, la Gestione separata segue le stesse date (acconti 40% + 40% sui contributi dell'anno precedente); per ENPAPI o un'altra cassa si inseriscono fino a 3 scadenze (gg/mm e percentuale) nel profilo fiscale (`pensionFund`, `customDeadlines`). Nell'area riservata compare un promemoria 15 giorni prima di ogni scadenza, che si può nascondere per la sessione. Sono tutte stime da verificare con il commercialista. Logica in `buildTaxSchedule`, `taxAdvancePlan`, `businessDayOnOrAfter` e `upcomingTaxDeadline` (`index.html`). Test: `tests/unit/tax-schedule.test.js`, `tests/integration/tax-schedule.test.js`, `tests/e2e/tax-schedule.spec.js` (orologio fissato al 20 giugno 2030).

## Messaggi WhatsApp ai pazienti

Dall'anagrafica pazienti il pulsante **WhatsApp** apre un menu di messaggi precompilati (richiesta notizie, nuovo appuntamento, recensione Google, ringraziamento, promemoria), in versione Osteopatia e Idrocolonterapia. I testi sono in `WHATSAPP_TEMPLATES` in `index.html`; il link recensioni si imposta dall'app ed è salvato in `shared/data/settings/messaging`. Test: `tests/unit/whatsapp.test.js`, `tests/integration/patient-messages.test.js`, `tests/e2e/patient-messages.spec.js`.

## Richieste di appuntamento dal sito

Nella sezione Contatti il modulo "Richiedi un appuntamento in studio" (solo osteopatia nello studio privato) salva le richieste in `artifacts/{app}/requests` con i soli campi previsti dalle regole Firestore.
- Antispam: campo nascosto, tempo minimo di compilazione di 3 secondi (ai robot si mostra comunque il messaggio di conferma, senza salvare) e un solo invio al minuto dallo stesso browser.
- Nell'area riservata la voce "Richieste" (con contatore delle nuove) permette di:
  - creare paziente e appuntamento con i dati precompilati (se il paziente esiste già, per telefono o nome, viene selezionato); quando l'appuntamento è salvato la richiesta diventa "Appuntamento creato";
  - rispondere su WhatsApp;
  - archiviare;
  - eliminare.
- Le richieste sono incluse nel backup.

Logica in `validateAppointmentRequest`, `isLikelySpam`, `submitAppointmentRequest` e `convertRequest` (`index.html`). Test: `tests/unit/appointment-requests.test.js`, `tests/integration/appointment-requests.test.js`, `tests/e2e/appointment-requests.spec.js` (con controllo di accessibilità del modulo) e `tests/rules` per la regola "solo creazione".

## Regole di sicurezza Firestore

`firestore.rules` è la copia di riferimento delle regole pubblicate nella console Firebase. `tests/rules/firestore-rules.test.js` le prova sull'emulatore Firestore (`npm run test:rules`, job "Regole Firestore" in CI) per visitatori, utenti anonimi, account non autorizzati, amministratori con email non verificata e amministratori, su tutte le collezioni usate da `index.html`. Istruzioni per pubblicarle: [`FIRESTORE_RULES.md`](FIRESTORE_RULES.md).

## Come funzionano i doppi di test

- **Firebase** → `tests/mocks/firebase/firebase-mock-core.js`: implementazione in memoria di `initializeApp`, Auth (anonimo, popup Google, signOut, `onAuthStateChanged`) e Firestore (`doc`, `collection`, `getDoc(s)`, `setDoc` con `merge`, `deleteDoc`, `onSnapshot` realtime). Lo stesso modulo è usato in jsdom e nel browser (dove sostituisce gli URL `https://www.gstatic.com/firebasejs/...`). Dai test si controlla tramite `window.__firebaseMock` (`seed`, `get`, `list`, `failNext` per simulare errori di permesso, `setPopupUser`, …).
- **Dati di esempio** → `tests/fixtures/seed.js` (`seedDocs`, `center`, `patient`, `studioEvent`) e `tests/fixtures/ical.js`.
- **jsdom** → `tests/support/jsdom-app.js` (`bootApp`) carica `index.html`, sostituisce gli `import` con il mock, espone `appState` e le funzioni interne in `window.__app`, e fornisce un FullCalendar minimale. Helper: `login()`, `submit(formId)`, `confirm()`, `setValue()`.
- **Estrazione funzioni** → `tests/support/app-source.js` (`loadFunctions([...])`) analizza lo script con acorn ed estrae le funzioni per testarle isolatamente.
- **Browser offline** → `tests/e2e/fixtures.js` intercetta tutte le richieste esterne: Tailwind Play CDN è sostituito da CSS compilato con la stessa configurazione (`tests/support/build-tailwind.mjs`, eseguito in `global-setup`), FullCalendar è servito da `node_modules` (stessa versione 6.1.8), font/icone restituiscono risposte vuote e ogni altra richiesta è bloccata e segnalata.
- **Server locale** → `tests/support/server.mjs` replica Vercel: file statici + `/api/ical` eseguito dalla funzione reale + calendari di prova in `/__fixtures__/` (anche modificabili via `PUT /__fixtures__/dynamic/<chiave>.ics`).

Tutti i test girano con fuso `Europe/Rome` e locale `it-IT`.

## Difetti trovati e corretti

L'ambiente di test ha individuato i difetti seguenti, ora corretti. Ognuno è coperto da test di regressione (commento `Regressione (difetto corretto)` nel codice dei test).

| Area | Difetto | Correzione | Test |
|---|---|---|---|
| Sync iCal | Orari con `TZID` (o senza `Z`) letti come UTC: appuntamenti spostati di 1–2 ore | Conversione dal fuso indicato (IANA); orari senza fuso = ora locale | `ical-parsing`, `ical-sync` |
| Sync iCal | Se il download di un calendario falliva, **tutti** i suoi eventi venivano proposti come "rimossi alla fonte" | Gli eventi delle sedi non scaricate restano invariati | `ical-sync` |
| Sync iCal | Errore di download invisibile: la sede risultava "Nessuna variazione" | Avviso e badge "Errore di sincronizzazione" nel report | `ical-sync`, `sync-report`, E2E |
| Sync iCal | A ogni sincronizzazione gli appuntamenti importati venivano riscritti da zero: compenso, stato del pagamento e note inseriti a mano andavano persi | I dati esistenti dell'evento vengono conservati; i nuovi eventi ricevono il compenso dalla tariffa della sede | `rates-shifts` |
| Sync iCal | Righe ICS ripiegate (RFC 5545), caratteri con escape (`\,`) e proprietà con parametri (`SUMMARY;LANGUAGE=it:`) non gestiti | Nuovo parser di righe/proprietà | `ical-parsing`, `ical-sync` |
| Agenda | Con salvataggio fallito l'appuntamento restava comunque in agenda | Lo stato locale si aggiorna solo dopo la scrittura su Firestore | `appointments` |
| Agenda | Si poteva salvare un appuntamento che finisce prima di iniziare | Validazione con messaggio | `appointments` |
| Contenuti | Errori di salvataggio/eliminazione di sedi, trattamenti, news e guide ignorati ("salvato" comunque) | Messaggio d'errore e nessuna modifica locale | `content-admin` |
| Sicurezza | Contenuti inseriti con `innerHTML` senza escape (XSS), link `javascript:` possibili | Escape di tutti i testi, solo link `http(s)`/`mailto`, colori e icone validati, `rel="noopener noreferrer"` | `public-site`, `safe-html` |
| Sicurezza | `/api/ical` scaricava qualunque URL, anche host interni (SSRF), e accettava ogni metodo | Solo `http(s)` verso indirizzi pubblici (verificati via DNS e a ogni redirect, max 5), `405` per metodi diversi da GET | `api-ical`, `api-server` |
| Dati | Un errore in una migrazione una-tantum impediva il caricamento di pazienti e appuntamenti | Ogni migrazione è isolata e ritentata al prossimo accesso | `migrations` |
| Agenda | Un aggiornamento in tempo reale (es. salvataggio di una scheda paziente) riportava sede e paziente del modulo appuntamento aperto ai valori predefiniti | Gli elenchi ricostruiti mantengono la scelta corrente | `appointments` |
| Richiami | Il link WhatsApp usava il numero senza prefisso internazionale (`333…` → `wa.me/333…`, non funzionante) | `normalizeWhatsAppNumber` aggiunge `39` ai numeri italiani | `whatsapp`, `patient-messages` |
| Contenuti | Le guide di preparazione non si potevano modificare (mancava il pulsante "Modifica") | Aggiunto `Modifica` come per news e trattamenti | `controls` (E2E) |
| Accessibilità | Etichette del modulo appuntamento non associate ai campi, pulsanti "chiudi" senza nome, contrasto 4.45:1 del badge data news | `for`/`aria-label`, colore più scuro | `accessibility` (E2E) |

Nota: il server locale di test (`npm run serve`, E2E) imposta `ICAL_ALLOW_PRIVATE_HOSTS=1` perché i calendari di prova sono su `127.0.0.1`; **non** impostare questa variabile in produzione.

## Aggiungere un test

- Logica pura → `tests/unit/*.test.js` con `loadFunctions(['nomeFunzione'], { appState })`.
- Flusso applicativo veloce → `tests/integration/*.test.js` con `bootApp({ docs: seedDocs({...}) })` e `await app.login()`.
- Flusso nel browser → `tests/e2e/*.spec.js` importando `test`, `expect`, `loginViaUi` da `./fixtures.js`; per i dati usare `test.use({ firebaseSeed: { docs: seedDocs({...}), popupUser } })`.
