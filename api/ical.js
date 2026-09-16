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
    if (targetUrl.includes('calendar.google.com')) {
      if (targetUrl.includes('cid=')) {
        const urlObj = new URL(targetUrl);
        const cid = urlObj.searchParams.get('cid');
        if (cid) {
          targetUrl = `https://calendar.google.com/calendar/ical/${encodeURIComponent(cid)}/public/basic.ics`;
        }
      } else if (targetUrl.includes('/embed?')) {
        targetUrl = targetUrl.replace('/embed?', '/exporticalendar?');
      }
    }

    const response = await fetch(targetUrl);
    if (!response.ok) {
      return res.status(500).json({ error: `Errore HTTP Google: ${response.status}` });
    }

    const icsText = await response.text();
    return res.status(200).json({ icsContent: icsText });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}