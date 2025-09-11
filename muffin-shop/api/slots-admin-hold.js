// api/slots-admin-hold.js
// Add or release admin holds for a date/window to consume/free capacity + CORS.
// Body: { date, window, qty, action: 'hold'|'release' }
// Auth: X-Admin-Token

export default async function handler(req, res) {
  // CORS
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token');
    res.status(204).end(); return;
  }
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST'){
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok:false, error:'method_not_allowed' });
  }
  try {
    const token = (req.headers['x-admin-token'] || '').toString();
    if (!process.env.ADMIN_API_TOKEN || token !== process.env.ADMIN_API_TOKEN) {
      return res.status(401).json({ ok:false, error:'unauthorized' });
    }
    const body = await readJson(req);
    const date = (body.date || '').toString();
    const window = (body.window || '').toString();
    const qty = Math.max(1, Number(body.qty || 1));
    const action = (body.action || 'hold').toString();

    const base = process.env.AIRTABLE_BASE_ID;
    const table = encodeURIComponent(process.env.AIRTABLE_TABLE_SLOTS || 'Slots');
    const url = `https://api.airtable.com/v0/${base}/${table}`;
    const headers = { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' };

    if (action === 'hold'){
      const records = Array.from({length: qty}).map(()=> ({ fields: { Date: date, Window: window, Status: 'confirmed', Items: 1, Note: 'admin_hold', Updated: new Date().toISOString() } }));
      const r = await fetch(url, { method:'POST', headers, body: JSON.stringify({ records }) });
      if (!r.ok) return res.status(500).json({ ok:false, error:'airtable_create_failed', detail: await r.text() });
      return res.status(200).json({ ok:true, created: qty });
    } else {
      // release: find admin_hold confirmed rows and delete up to qty
      const u = new URL(url);
      u.searchParams.set('filterByFormula', `AND({Date}='${date}', {Window}='${window}', {Status}='confirmed', {Note}='admin_hold')`);
      const list = await fetch(u.toString(), { headers: { Authorization: headers.Authorization } });
      if (!list.ok) return res.status(500).json({ ok:false, error:'airtable_list_failed', detail: await list.text() });
      const j = await list.json();
      const ids = (j.records || []).slice(0, qty).map(r => r.id);
      if (ids.length === 0) return res.status(200).json({ ok:true, deleted: 0 });
      const del = await fetch(`${url}?records[]=` + ids.join('&records[]='), { method:'DELETE', headers: { Authorization: headers.Authorization } });
      if (!del.ok) return res.status(500).json({ ok:false, error:'airtable_delete_failed', detail: await del.text() });
      return res.status(200).json({ ok:true, deleted: ids.length });
    }
  } catch (e) {
    console.error('slots-admin-hold error', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
}

async function readJson(req){
  const buf = await new Response(req.body).text();
  try { return JSON.parse(buf || '{}'); } catch { return {}; }
}
