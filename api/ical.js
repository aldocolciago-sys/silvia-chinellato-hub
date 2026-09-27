import { lookup } from 'node:dns/promises';
import net from 'node:net';

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 15000;

/**
 * Indirizzi che il proxy non deve mai contattare: rete locale, loopback,
 * link-local (metadata dei cloud provider), CGNAT, multicast e riservati.
 */
const BLOCKED_ADDRESSES = new net.BlockList();
for (const [network, prefix] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
    ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]
]) BLOCKED_ADDRESSES.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
    ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]
]) BLOCKED_ADDRESSES.addSubnet(network, prefix, 'ipv6');

class UnsafeUrlError extends Error {}

export default async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({
      error: 'Metodo non consentito'
    });
  }

  const icalUrl = req.query.url;

  if (!icalUrl) {
    return res.status(400).json({
      error: 'URL iCal mancante'
    });
  }

  let targetUrl = normalizeGoogleCalendarUrl(icalUrl);

  try {

    console.log('Fetching calendar:', targetUrl);

    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, TIMEOUT_MS);

    let response;
    try {
      response = await fetchPublicUrl(targetUrl, controller.signal);
    } finally {
      clearTimeout(timeout);
    }

    console.log('HTTP Status:', response.status);
    console.log(
      'Content-Type:',
      response.headers.get('content-type')
    );

    if (!response.ok) {

      return res.status(response.status).json({
        error: `Errore HTTP ${response.status}`,
        targetUrl
      });

    }

    const icsText = await response.text();

    if (!icsText) {

      return res.status(500).json({
        error: 'Google ha restituito una risposta vuota'
      });

    }

    const isValidCalendar =
      icsText.includes('BEGIN:VCALENDAR') ||
      icsText.includes('BEGIN:VEVENT');

    if (!isValidCalendar) {

      return res.status(500).json({
        error:
          'La risposta non contiene un calendario iCal valido. Probabilmente il calendario non è pubblico oppure Google ha restituito una pagina HTML.',
        preview: icsText.substring(0, 300)
      });

    }

    return res.status(200).json({
      icsContent: icsText
    });

  } catch (error) {

    console.error(error);

    if (error instanceof UnsafeUrlError) {
      return res.status(400).json({
        error: error.message
      });
    }

    if (error.name === 'AbortError') {
      return res.status(504).json({
        error: 'Timeout durante il download del calendario'
      });
    }

    return res.status(500).json({
      error: error.message
    });

  }
}


/**
 * Scarica un URL seguendo manualmente i redirect, verificando a ogni passaggio
 * che la destinazione sia un host pubblico (protezione SSRF).
 */
async function fetchPublicUrl(url, signal) {

  let currentUrl = url;

  for (let hop = 0; ; hop++) {

    await assertPublicHttpUrl(currentUrl);

    const response = await fetch(currentUrl, {
      redirect: 'manual',
      signal,
      headers: {
        'Accept': 'text/calendar,text/plain,*/*'
      }
    });

    const location = response.headers.get('location');
    const isRedirect = response.status >= 300 && response.status < 400 && location;

    if (!isRedirect) return response;

    if (hop >= MAX_REDIRECTS) {
      throw new UnsafeUrlError('Troppi redirect durante il download del calendario');
    }

    currentUrl = new URL(location, currentUrl).toString();
  }
}


/**
 * Accetta solo URL http(s) che risolvono esclusivamente verso indirizzi pubblici.
 * Per i test locali si può disattivare il controllo con ICAL_ALLOW_PRIVATE_HOSTS=1.
 */
async function assertPublicHttpUrl(url) {

  let urlObj;
  try {
    urlObj = new URL(url);
  } catch (e) {
    throw new UnsafeUrlError('URL iCal non valido');
  }

  if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
    throw new UnsafeUrlError('Sono consentiti solo URL http o https');
  }

  if (process.env.ICAL_ALLOW_PRIVATE_HOSTS === '1') return;

  const hostname = urlObj.hostname.replace(/^\[|\]$/g, '');

  const addresses = net.isIP(hostname)
    ? [{ address: hostname, family: net.isIP(hostname) }]
    : await lookup(hostname, { all: true, verbatim: true });

  for (const { address, family } of addresses) {
    if (isBlockedAddress(address, family)) {
      throw new UnsafeUrlError('URL non consentito: il calendario deve trovarsi su un indirizzo pubblico');
    }
  }
}


function isBlockedAddress(address, family) {

  if (family === 6 || family === 'IPv6') {
    const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped) return BLOCKED_ADDRESSES.check(mapped[1], 'ipv4');
    return BLOCKED_ADDRESSES.check(address, 'ipv6');
  }

  return BLOCKED_ADDRESSES.check(address, 'ipv4');
}


/**
 * Converte vari URL Google Calendar
 * nell'URL standard ICS pubblico.
 */
function normalizeGoogleCalendarUrl(url) {

  try {

    const urlObj = new URL(url);

    if (!url.includes('calendar.google.com')) {
      return url;
    }

    const cid = urlObj.searchParams.get('cid');

    if (!cid) {
      return url;
    }

    let calendarId = cid;

    try {

      const decoded = Buffer
        .from(cid, 'base64')
        .toString('utf8');

      if (
        decoded &&
        decoded.includes('@')
      ) {
        calendarId = decoded;
      }

    } catch (e) {
      // non era base64
    }

    calendarId = decodeURIComponent(calendarId);

    return `https://calendar.google.com/calendar/ical/${calendarId}/public/basic.ics`;

  } catch (e) {

    return url;

  }

}
