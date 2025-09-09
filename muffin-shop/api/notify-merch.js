// api/notify-merch.js
export default async function handler(req, res){
  if (req.method !== 'POST') {
    res.setHeader('Allow','POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  try{
    const { email } = req.body || {};
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Valid email required' });
    }

    const payload = {
      type: 'merch_waitlist',
      email,
      ua: req.headers['user-agent'] || '',
      ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '',
      ts: new Date().toISOString()
    };

    // 1) If you have a webhook (Zapier/Make) set MERCH_WEBHOOK_URL
    if (process.env.MERCH_WEBHOOK_URL) {
      await fetch(process.env.MERCH_WEBHOOK_URL, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify(payload)
      });
      return res.status(204).end();
    }

    // 2) Optional: Airtable (set AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_TABLE_MERCH)
    if (process.env.AIRTABLE_API_KEY && process.env.AIRTABLE_BASE_ID && process.env.AIRTABLE_TABLE_MERCH) {
      const url = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(process.env.AIRTABLE_TABLE_MERCH)}`;
      const atRes = await fetch(url, {
        method:'POST',
        headers:{
          'Authorization':`Bearer ${process.env.AIRTABLE_API_KEY}`,
          'Content-Type':'application/json'
        },
        body: JSON.stringify({ records:[{ fields:{ Email: email, Source:'website', Created: payload.ts } }] })
      });
      if (!atRes.ok) {
        const t = await atRes.text();
        console.error('Airtable error:', atRes.status, t);
      }
      return res.status(204).end();
    }

    // 3) Fallback: Accept without external storage (logs only)
    console.log('Merch waitlist signup:', payload);
    return res.status(204).end();
  }catch(err){
    console.error('notify-merch error', err);
    return res.status(500).json({ error:'Server error' });
  }
}
