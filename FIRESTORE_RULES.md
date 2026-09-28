# Regole di sicurezza Firestore

Il file [`firestore.rules`](firestore.rules) contiene le regole di sicurezza del database. È la copia di riferimento di quelle pubblicate nella console Firebase, e i test automatici (`npm run test:rules`, job "Regole Firestore" su GitHub) le verificano a ogni modifica.

## Chi può fare cosa

| Dati | Visitatori e utenti anonimi | Account Google non autorizzato | Silvia e Aldo (email verificata) |
|---|---|---|---|
| Sito pubblico (`public/data`: sedi, trattamenti, news, guide) | Leggere | Leggere | Leggere e modificare |
| Pazienti, agenda, sedute, compensi, impostazioni (`shared/data`) | Nessun accesso | Nessun accesso | Leggere e modificare |
| Richieste di appuntamento dal sito (`requests`) | Solo **inviare** una richiesta valida | Solo inviare | Leggere, archiviare, eliminare |
| Dati legacy per utente (`users/{uid}`) | Nessun accesso | Nessun accesso | Solo i propri |
| Qualunque altro percorso | Nessun accesso | Nessun accesso | Nessun accesso |

Una richiesta di appuntamento è valida solo se:
- contiene esclusivamente i campi previsti;
- nome (2–100 caratteri), telefono (6–30 caratteri) e consenso sono presenti;
- lo stato è `new`;
- i testi rispettano i limiti di lunghezza.

## Come pubblicarle

1. Apri la [console Firebase](https://console.firebase.google.com/) → progetto dell'app → **Firestore Database** → scheda **Regole**.
2. Sostituisci tutto il testo con il contenuto di `firestore.rules` e premi **Pubblica**.
3. Verifica:
   - in incognito il sito mostra i contenuti;
   - nell'area riservata si salva e si elimina una news di prova.

Rispetto alle regole pubblicate a settembre 2026, l'unica novità è il blocco **Richieste di appuntamento dal sito**. Serve alla funzione di richiesta appuntamento; finché non la attivi, pubblicarlo non cambia nulla.

## Test

- `npm run test:rules` avvia l'emulatore Firestore (serve Java 21) ed esegue `tests/rules/firestore-rules.test.js`. Le regole vengono provate per visitatori, utenti anonimi, account non autorizzati, amministratori con email non verificata e amministratori. Il test ricava da `index.html` l'elenco delle collezioni usate dall'app, così una collezione nuova non coperta dalle regole fa fallire il test.
- `tests/unit/firestore-rules-file.test.js` controlla che gli account autorizzati nelle regole siano gli stessi di `AUTHORIZED_EMAILS` nell'app.
