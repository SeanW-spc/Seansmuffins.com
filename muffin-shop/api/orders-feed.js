// api/orders-feed.js
// Secure JSON feed of orders for a given date/status.
// Auth: header "X-Admin-Token: <ADMIN_API_TOKEN>" OR query ?token=... (for quick tests)

export default async function handler(req, res) {
  try {
    const token = (req.headers['x-admin-token'] || req.query.token || '').toString();
    if (!process.env.ADMIN_API_TOKEN || token !== process.env.ADMIN_API_TOKEN) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const base = process.env.AIRTABLE_BASE_ID;
    const table = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || 'Orders');
    const url = `https://api.airtable.com/v0/${base}/${table}`;

    const date = (req.query.date || '').toString() || new Date().toISOString().slice(0,10);
    const status = (req.query.status || '').toString(); // e.g., unassigned|scheduled

    let formula = `{delivery_date}='${date}'`;
    if (status) formula = `AND(${formula}, {status}='${status}')`;

    const all = await airtableList(url, formula, [
      { field: 'preferred_window', direction: 'asc' },
      { field: 'created', direction: 'asc' }
    ]);

    const data = all.map(r => {
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
      };
    });

    res.status(200).json({ ok: true, date, count: data.length, orders: data });
  } catch (err) {
    console.error('orders-feed error', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
}

async function airtableList(baseUrl, filterByFormula, sorts = []) {
  const headers = { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` };
  let offset = null;
  const out = [];
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
