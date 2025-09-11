// api/orders-update-status.js
// PATCH a single order's status / delivery_time / route_position + CORS.

export default async function handler(req, res) {
  // CORS
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token');
    res.status(204).end(); return;
  }
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  try {
    const token = (req.headers['x-admin-token'] || '').toString();
    if (!process.env.ADMIN_API_TOKEN || token !== process.env.ADMIN_API_TOKEN) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    const body = await readJson(req);
    const { id, status, delivery_time, route_position } = body || {};
    if (!id) return res.status(400).json({ ok: false, error: 'missing_id' });

    const fields = {};
    if (status) fields.status = status;
    if (typeof delivery_time === 'string') fields.delivery_time = delivery_time;
    if (typeof route_position !== 'undefined') fields.route_position = route_position;

    const base = process.env.AIRTABLE_BASE_ID;
    const table = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || 'Orders');
    const url = `https://api.airtable.com/v0/${base}/${table}`;

    const r = await fetch(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ records: [{ id, fields }] })
    });
    if (!r.ok) {
      const txt = await r.text().catch(()=> '');
      return res.status(500).json({ ok: false, error: 'airtable_update_failed', detail: txt });
    }
    const j = await r.json();
    res.status(200).json({ ok: true, updated: j.records?.[0]?.id || id });
  } catch (err) {
    console.error('orders-update-status error', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
}

async function readJson(req){
  const buf = await new Response(req.body).text();
  try { return JSON.parse(buf || '{}'); } catch { return {}; }
}
