# Riepilogo automatico su WhatsApp alle 7:00

Ogni mattina Silvia riceve sul proprio WhatsApp il promemoria di oggi e domani:

```
☀️ Buongiorno Silvia! Oggi è giovedì 1 ottobre.

*Oggi* (1)
• 09:00 – M.R. – Osteopatia – studio

*Domani, venerdì 2 ottobre* (2)
• 10:00 – senza paziente – studio
• 15:00 – A.D. – Idrocolonterapia – CMS Carate ⚠️ senza telefono

📲 1 promemoria da inviare ai pazienti
⚠️ 1 paziente senza telefono
⚠️ 1 appuntamento senza paziente associato

Apri l'agenda: https://…
```

Il messaggio contiene solo le **iniziali** dei pazienti. Le regole sono le stesse della finestra *Promemoria*:

- esclusi i turni, i calendari personali, gli appuntamenti annullati e quelli di un'intera giornata;
- di oggi compaiono solo gli appuntamenti non ancora iniziati.

## Come funziona

- `api/daily-reminder.js` è una funzione Vercel che:
  - legge agenda, pazienti e sedi da Firestore con le credenziali di servizio;
  - compone il testo (`api/_daily-reminder-core.js`);
  - lo invia con [CallMeBot](https://www.callmebot.com/blog/free-api-whatsapp-messages/), servizio gratuito che scrive solo sul numero di chi lo ha attivato.
- `vercel.json` la richiama due volte, alle 5:00 e alle 6:00 UTC. La funzione invia soltanto dalle 7:00 di Roma e una sola volta al giorno: così l'orario resta giusto sia con l'ora legale sia con l'ora solare.
- L'esito dell'ultimo invio viene salvato in `shared/data/settings/daily_reminder` e compare nell'app, sotto la finestra *Promemoria*.

> Sul piano **Hobby** (gratuito) di Vercel i cron partono in un momento qualsiasi entro l'ora indicata: il messaggio arriva tra le 7:00 e le 7:59.
> Sul piano **Pro** arriva alle 7:00 in punto.
> Per l'orario esatto anche sul piano Hobby si può aggiungere un servizio di cron gratuito come cron-job.org (vedi in fondo).

## Configurazione (una volta sola)

### 1. Attivare CallMeBot sul telefono di Silvia
1. Apri la [pagina di CallMeBot per WhatsApp](https://www.callmebot.com/blog/free-api-whatsapp-messages/) e salva nei contatti il numero indicato lì.
2. Dal WhatsApp di Silvia manda a quel contatto il messaggio `I allow callmebot to send me messages`.
3. Entro qualche minuto arriva la risposta con la **apikey**. Conservala: serve al punto 3.

### 2. Creare la chiave di servizio Firebase
1. Apri la [console Firebase](https://console.firebase.google.com/), progetto **silvia-chinellato-hub**.
2. Vai in ⚙️ **Impostazioni progetto → Account di servizio → Genera nuova chiave privata**: si scarica un file `.json`.
3. Il file dà accesso completo al database, dati sanitari compresi:
   - non va caricato su GitHub né mandato per email o chat;
   - dopo averlo incollato su Vercel (punto 3), cancellalo dal computer.

### 3. Variabili d'ambiente su Vercel
Vai in Vercel → progetto → **Settings → Environment Variables** e aggiungi queste variabili, per l'ambiente *Production*:

| Nome | Valore |
|---|---|
| `CALLMEBOT_PHONE` | numero di Silvia con prefisso, es. `+393331234567` |
| `CALLMEBOT_APIKEY` | la apikey ricevuta da CallMeBot |
| `FIREBASE_SERVICE_ACCOUNT` | l'intero contenuto del file `.json` del punto 2 |
| `CRON_SECRET` | una stringa casuale lunga (almeno 32 caratteri), es. generata con `openssl rand -hex 32` |
| `APP_URL` | *facoltativa*: l'indirizzo del sito da mettere in fondo al messaggio |

Poi fai un nuovo deploy di produzione (**Deployments → … → Redeploy**), perché le variabili valgono solo dai deploy successivi.

### 4. Attivare l'invio dall'app
1. Area riservata → **Promemoria** (campanella su computer, **Altro → Promemoria** su telefono).
2. In fondo alla finestra, nel riquadro **Riepilogo automatico alle 7:00**, spunta *Ogni mattina invia questo promemoria sul WhatsApp di Silvia*.
3. Premi **Invia una prova ora**: entro pochi secondi arriva un messaggio che inizia con "🧪 Messaggio di prova". Le prove sono limitate a una al minuto.

Per sospendere gli invii basta togliere la spunta: non serve toccare Vercel.

## Se qualcosa non va

- **"Configurazione mancante su Vercel: …"**: manca una delle variabili del punto 3, oppure non è stato fatto il nuovo deploy.
- **"CallMeBot ha rifiutato il messaggio … APIKey is invalid"**: apikey o numero sbagliati. Ripeti il punto 1.
- **"Sessione non valida"** quando si preme la prova: esci e rientra nell'area riservata.
- **Nessun messaggio, nessun errore**:
  - controlla che la spunta sia attiva;
  - in Vercel → **Settings → Cron Jobs** controlla che i cron siano abilitati;
  - nei log della funzione `/api/daily-reminder` si vede il motivo di ogni chiamata. Per esempio: "Riepilogo di oggi già inviato", oppure "Non sono ancora le 7 a Roma", che con l'ora solare è normale per la chiamata delle 5:00 UTC.

## Orario esatto con cron-job.org (facoltativo)
1. Su [cron-job.org](https://cron-job.org) crea un job che chiama `https://<indirizzo-del-sito>/api/daily-reminder` ogni giorno alle **07:00**, con fuso **Europe/Rome**.
2. Nelle impostazioni avanzate aggiungi l'intestazione `Authorization` con il valore `Bearer <CRON_SECRET>`.

Il doppio invio non è possibile, perché la funzione manda un solo riepilogo al giorno: si possono quindi lasciare attivi anche i cron di Vercel come riserva.

## Privacy
- Il testo passa da CallMeBot, un servizio esterno senza garanzie contrattuali. Per questo il messaggio contiene solo iniziali, orari, trattamento e sede, mai nomi completi, telefoni o note cliniche.
- Le credenziali (`FIREBASE_SERVICE_ACCOUNT`, `CALLMEBOT_APIKEY`, `CRON_SECRET`) stanno solo nelle variabili d'ambiente di Vercel. Non vanno mai inserite nel codice.
- Le regole Firestore non cambiano: la funzione usa le credenziali di servizio, che non passano dalle regole.
