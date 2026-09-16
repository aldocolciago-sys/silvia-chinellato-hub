export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const icalUrl = req.query.url;
  if (!icalUrl) {
    return res.status(400).json({ error: 'URL iCal mancante' });
  }

  try {
    let targetUrl = icalUrl;
    
    // Normalizzazione robusta link Google Calendar
    if (targetUrl.includes('calendar.google.com')) {
      if (targetUrl.includes('cid=')) {
        try {
          const urlObj = new URL(targetUrl);
          const cid = urlObj.searchParams.get('cid');
          if (cid) {
            targetUrl = `https://calendar.google.com/calendar/ical/${encodeURIComponent(cid)}/public/basic.ics`;
          }
        } catch(e) {}
      } else if (targetUrl.includes('/embed?')) {
        targetUrl = targetUrl.replace('/embed?', '/exporticalendar?');
      } else if (!targetUrl.endsWith('.ics') && !targetUrl.includes('/exporticalendar?')) {
        if (targetUrl.includes('/calendar/u/')) {
          try {
            const urlObj = new URL(targetUrl);
            const cid = urlObj.searchParams.get('cid');
            if (cid) {
              targetUrl = `https://calendar.google.com/calendar/ical/${encodeURIComponent(cid)}/public/basic.ics`;
            }
          } catch(e) {}
        }
      }
    }

    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: `Errore HTTP Google: ${response.status} per URL: ${targetUrl}` });
    }

    const icsText = await response.text();
    if (!icsText || (!icsText.includes('BEGIN:VCALENDAR') && !icsText.includes('BEGIN:VEVENT'))) {
      return res.status(500).json({ error: 'Il contenuto restituito non è un formato iCal valido. Verifica che il calendario sia pubblico.' });
    }

    return res.status(200).json({ icsContent: icsText });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}