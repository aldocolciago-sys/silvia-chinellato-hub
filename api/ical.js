export default async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const icalUrl = req.query.url;

  if (!icalUrl) {
    return res.status(400).json({
      error: 'URL iCal mancante'
    });
  }

  try {

    let targetUrl = normalizeGoogleCalendarUrl(icalUrl);

    console.log('Fetching calendar:', targetUrl);

    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, 15000);

    const response = await fetch(targetUrl, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'Accept': 'text/calendar,text/plain,*/*'
      }
    });

    clearTimeout(timeout);

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