// api/orders-feed.js
// Secure JSON feed of orders for a given date/status + CORS.
// Auth: Authorization: Bearer <ADMIN_API_TOKEN>  (also supports x-admin-token and ?token=)

function withCors(req, res) {
  // If you want to lock this down, replace * with your localhost origin(s)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Token');
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  return false;
}

function getAdminToken(req) {
  // Preferred: Authorization: Bearer <token>
  const auth = (req.headers.authorization || '').trim();
  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7);
  }
  // Back-compat: x-admin-token header
  const hdr = (req.headers['x-admin-token'] || '').toString().trim();
  if (hdr) return hdr;
  // Fallbacks: ?token= or JSON {token}
  const q = (req.query && req.query.token) ? String(req.query.token) : '';
  if (q) return q;
  try {
    if (req.body && typeof req.body === 'object' && req.body.token) {
      return String(req.body.token);
    }
  } catch {}
  return '';
}

export default async function handler(req, res) {
  if (withCors(req, res)) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET,OPTIONS');
    return res.status(405).json({ ok:false, error:'method_not_allowed' });
  }

  try {
    const token = getAdminToken(req);
    if (!process.env.ADMIN_API_TOKEN || token !== process.env.ADMIN_API_TOKEN) {
      return res.status(401).json({ ok:false, error:'unauthorized' });
    }

    if (!process.env.AIRTABLE_API_KEY || !process.env.AIRTABLE_BASE_ID) {
      return res.status(500).json({ ok:false, error:'airtable_config' });
    }

    const baseId = process.env.AIRTABLE_BASE_ID;
    const table  = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || 'Orders');
    const apiUrl = `https://api.airtable.com/v0/${baseId}/${table}`;

    // Filters
    const today = new Date().toISOString().slice(0,10);
    const date = String(req.query.date || today);
    const status = (req.query.status ? String(req.query.status) : '').trim();

    // Your Orders table uses lowercase field names (per your schema):
    // stripe_session_id, created_at, customer_name, email, phone, address,
    // items, preferred_window, delivery_date, delivery_time, route_position,
    // status, total, notes.

    // Filter: exact date match, optional status
    let filterFormula = `{delivery_date}='${date}'`;
    if (status) filterFormula = `AND(${filterFormula}, {status}='${status}')`;

    // Sort: by preferred_window, then created_at (oldest first)
    const sortBy = [
      { field: 'preferred_window', direction: 'asc' },
      { field: 'created_at',       direction: 'asc' }
    ];

    const records = await listAirtable(apiUrl, filterFormula, sortBy);

    const orders = records.map(r => {
      const f = r.fields || {};
      return {
        id: r.id,
        delivery_date:     f.delivery_date || '',
        preferred_window:  f.preferred_window || '',
        status:            f.status || '',
        delivery_time:     f.delivery_time || '',
        route_position:    (f.route_position ?? null),
        customer_name:     f.customer_name || '',
        email:             f.email || '',
        phone:             f.phone || '',
        address:           f.address || '',
        notes:             f.notes || '',
        total:             (f.total ?? null),
        items:             f.items || '',              // include if present
        stripe_session_id: f.stripe_session_id || '',
        created_at:        f.created_at || '',
      };
    });

    return res.status(200).json({ ok:true, date, count: orders.length, orders });
  } catch (err) {
    console.error('orders-feed error', err?.message || err);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
}

async function listAirtable(baseUrl, filterByFormula, sorts = []) {
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
