// api/orders-feed.js
// Secure JSON feed of orders for a given date/status + CORS.
// Auth: X-Admin-Token header or ?token=...

export default async function handler(req, res) {
  // CORS
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token');
    res.status(204).end(); return;
  }
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const token = (req.headers['x-admin-token'] || req.query.token || '').toString();
    if (!process.env.ADMIN_API_TOKEN || token !== process.env.ADMIN_API_TOKEN) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const base = process.env.AIRTABLE_BASE_ID;
    const table = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || 'Orders');
    const url = `https://api.airtable.com/v0/${base}/${table}`;

    const date = (req.query.date || '').toString() || new Date().toISOString().slice(0,10);
    const status = (req.query.status || '').toString();
    let formula = `{delivery_date}='${date}'`;
    if (status) formula = `AND(${formula}, {status}='${status}')`;

    const all = await list(url, formula, [
      { field: 'preferred_window', direction: 'asc' },
      { field: 'created', direction: 'asc' }
    ]);

    const orders = all.map(r => {
      const f = r.fields || {};
      return {
        id: r.id,
        delivery_date: f.delivery_date || '',
        preferred_window: f.preferred_window || '',
        status: f.status || '',
        delivery_time: f.delivery_time || '',
        route_position: f.route_position ?? null,
        customer_name: f.customer_name || '',
        email: f.email || '',
        phone: f.phone || '',
        address: f.address || '',
        notes: f.notes || '',
        total: f.total ?? null,
        stripe_session_id: f.stripe_session_id || '',
        created: f.created || '',
        // items: f.items || ''  // include if your table has it
      };
    });

    res.status(200).json({ ok: true, date, count: orders.length, orders });
  } catch (err) {
    console.error('orders-feed error', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
}

async function list(baseUrl, filterByFormula, sorts = []) {
  const headers = { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` };
  let offset = null, out = [];
  do {
    const u = new URL(baseUrl);
    u.searchParams.set('pageSize', '100');
    if (filterByFormula) u.searchParams.set('filterByFormula', filterByFormula);
    if (offset) u.searchParams.set('offset', offset);
    sorts.forEach((s, i) => {
      u.searchParams.set(`sort[${i}][field]`, s.field);
      u.searchParams.set(`sort[${i}][direction]`, s.direction || 'asc');
    });
    const r = await fetch(u.toString(), { headers });
    if (!r.ok) throw new Error(`Airtable list ${r.status}: ${await r.text().catch(()=> '')}`);
    const j = await r.json();
    out.push(...(j.records || []));
    offset = j.offset;
  } while (offset);
  return out;
}
