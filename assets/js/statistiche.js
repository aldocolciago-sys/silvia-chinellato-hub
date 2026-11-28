/*
 * Statistiche di visita anonime del sito pubblico: nessun cookie, nessun identificativo.
 * Vedi l'informativa privacy (sezione "Statistiche di visita") e api/statistiche.js.
 *
 * Invia a /api/statistiche solo:
 *  - la pagina aperta, il dominio da cui si arriva (es. google.it) e se è la prima pagina della
 *    visita (un indicatore in sessionStorage, cancellato alla chiusura della scheda);
 *  - le azioni sugli elementi con data-stat (es. Instagram, email, telefono), le domande frequenti
 *    aperte e l'evento "statistiche:evento" (es. richiesta di appuntamento inviata).
 * I dispositivi di Silvia e Aldo non vengono contati: l'area riservata imposta
 * localStorage.statisticheIgnoraDispositivo = '1' al momento dell'accesso.
 */
(function () {
    'use strict';
    var ENDPOINT = '/api/statistiche';
    var IGNORE_KEY = 'statisticheIgnoraDispositivo';
    var VISIT_KEY = 'statisticheVisitaInCorso';

    function ignored() {
        try { return window.localStorage.getItem(IGNORE_KEY) === '1'; } catch (err) { return false; }
    }

    function send(signal) {
        if (ignored()) return;
        var body = JSON.stringify(signal);
        try {
            if (navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }))) return;
        } catch (err) { /* si prova con fetch */ }
        try {
            window.fetch(ENDPOINT, { method: 'POST', body: body, headers: { 'Content-Type': 'application/json' }, keepalive: true, credentials: 'omit' })
                .catch(function () { /* le statistiche non devono mai disturbare la pagina */ });
        } catch (err) { /* nessuna rete disponibile */ }
    }

    function referrerHost() {
        try { return document.referrer ? new URL(document.referrer).hostname : ''; } catch (err) { return ''; }
    }

    function utmSource() {
        try { return (new URLSearchParams(window.location.search).get('utm_source') || '').slice(0, 40); } catch (err) { return ''; }
    }

    function isNewVisit() {
        try {
            if (window.sessionStorage.getItem(VISIT_KEY)) return false;
            window.sessionStorage.setItem(VISIT_KEY, '1');
            return true;
        } catch (err) { return true; }
    }

    function sendEvent(name, detail) {
        if (!name) return;
        var signal = { tipo: 'evento', nome: String(name) };
        if (detail) signal.dettaglio = String(detail).slice(0, 80);
        send(signal);
    }

    // Azioni sugli elementi marcati con data-stat (e, se c'è, data-stat-dettaglio).
    document.addEventListener('click', function (event) {
        var target = event.target && event.target.closest ? event.target.closest('[data-stat]') : null;
        if (target) sendEvent(target.getAttribute('data-stat'), target.getAttribute('data-stat-dettaglio'));
    }, true);

    // Domande frequenti aperte ("toggle" non risale nel documento: si ascolta in fase di cattura).
    document.addEventListener('toggle', function (event) {
        var item = event.target;
        if (!item || !item.matches || !item.matches('details.faq-item') || !item.open) return;
        var summary = item.querySelector('summary');
        sendEvent('faq', summary ? summary.textContent.replace(/\s+/g, ' ').trim() : '');
    }, true);

    // Eventi segnalati dal resto della pagina, es. document.dispatchEvent(new CustomEvent('statistiche:evento', { detail: 'richiesta_appuntamento' })).
    document.addEventListener('statistiche:evento', function (event) {
        var detail = event.detail;
        if (typeof detail === 'string') sendEvent(detail);
        else if (detail && typeof detail === 'object') sendEvent(detail.nome, detail.dettaglio);
    });

    /** Usata dall'area riservata: true = questo dispositivo non viene contato. */
    window.statisticheIgnoraDispositivo = function (ignore) {
        try {
            if (ignore) window.localStorage.setItem(IGNORE_KEY, '1');
            else window.localStorage.removeItem(IGNORE_KEY);
        } catch (err) { /* archiviazione non disponibile */ }
    };

    send({ tipo: 'pagina', percorso: window.location.pathname, provenienza: referrerHost(), utm: utmSource(), nuovaVisita: isNewVisit() });
}());
