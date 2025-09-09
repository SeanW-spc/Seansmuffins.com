// api/vote-flavor.js
export default async function handler(req, res){
  if (req.method !== 'POST') {
    res.setHeader('Allow','POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  try{
    const { flavor } = req.body || {};
    const value = String(flavor || '').trim();
    if (!value) return res.status(400).json({ error:'Flavor is required' });

    const payload = {
      type: 'flavor_vote',
      flavor: value.slice(0, 80),
      ua: req.headers['user-agent'] || '',
      ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '',
      ts: new Date().toISOString()
    };

    // Webhook first (Zapier/Make)
    if (process.env.VOTE_WEBHOOK_URL) {
      await fetch(process.env.VOTE_WEBHOOK_URL, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify(payload)
      });
      return res.status(204).end();
    }

    // Airtable optional
    if (process.env.AIRTABLE_API_KEY && process.env.AIRTABLE_BASE_ID && process.env.AIRTABLE_TABLE_VOTES) {
      const url = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(process.env.AIRTABLE_TABLE_VOTES)}`;
      const atRes = await fetch(url, {
        method:'POST',
        headers:{
          'Authorization':`Bearer ${process.env.AIRTABLE_API_KEY}`,
          'Content-Type':'application/json'
        },
        body: JSON.stringify({ records:[{ fields:{ Flavor: payload.flavor, Created: payload.ts, Source:'website' } }] })
      });
      if (!atRes.ok) {
        const t = await atRes.text();
        console.error('Airtable error:', atRes.status, t);
      }
      return res.status(204).end();
    }

    console.log('Flavor vote:', payload);
    return res.status(204).end();
  }catch(err){
    console.error('vote-flavor error', err);
    return res.status(500).json({ error:'Server error' });
  }
}
