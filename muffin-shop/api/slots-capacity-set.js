// api/slots-capacity-set.js
// Upsert capacity override for a date/window in Airtable + CORS.
// Body: { date, window, capacity|null }   (null removes override)
// Auth: X-Admin-Token

export default async function handler(req, res) {
  // CORS
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token');
    res.status(204).end(); return;
  }
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') {
    res.setHeader('Allow','POST');
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
    const capacity = (body.capacity === null || body.capacity === undefined) ? null : Number(body.capacity);

    const base = process.env.AIRTABLE_BASE_ID;
    const table = encodeURIComponent(process.env.AIRTABLE_TABLE_SLOT_CAPS || 'SlotCaps');
    const url = `https://api.airtable.com/v0/${base}/${table}`;
    const headers = { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' };

    // find existing
    const find = new URL(url);
    find.searchParams.set('filterByFormula', `AND({Date}='${date}', {Window}='${window}')`);
    const r0 = await fetch(find.toString(), { headers: { Authorization: headers.Authorization } });
    if (!r0.ok) return res.status(500).json({ ok:false, error:'airtable_list_failed', detail: await r0.text() });
    const j0 = await r0.json();
    const rec = (j0.records || [])[0];

    if (capacity == null) {
      // remove override (delete record if exists)
      if (!rec) return res.status(200).json({ ok:true, removed:false });
      const del = await fetch(`${url}?records[]=${rec.id}`, { method: 'DELETE', headers: { Authorization: headers.Authorization } });
      if (!del.ok) return res.status(500).json({ ok:false, error:'airtable_delete_failed', detail: await del.text() });
      return res.status(200).json({ ok:true, removed:true });
    } else if (rec) {
      // update
      const upd = await fetch(url, { method:'PATCH', headers, body: JSON.stringify({ records: [{ id: rec.id, fields: { Capacity: capacity } }] }) });
      if (!upd.ok) return res.status(500).json({ ok:false, error:'airtable_update_failed', detail: await upd.text() });
      return res.status(200).json({ ok:true, updated:true });
    } else {
      // create
      const crt = await fetch(url, { method:'POST', headers, body: JSON.stringify({ records: [{ fields: { Date: date, Window: window, Capacity: capacity } }] }) });
      if (!crt.ok) return res.status(500).json({ ok:false, error:'airtable_create_failed', detail: await crt.text() });
      return res.status(200).json({ ok:true, created:true });
    }
  } catch (e) {
    console.error('slots-capacity-set error', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
}

async function readJson(req){
  const buf = await new Response(req.body).text();
  try { return JSON.parse(buf || '{}'); } catch { return {}; }
}
