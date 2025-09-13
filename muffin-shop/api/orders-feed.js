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

    // Filter: exact date match, optional status
    let filterFormula = `{delivery_date}='${date}'`;
    if (status) filterFormula = `AND(${filterFormula}, {status}='${status}')`;

    // Sort: by preferred_window, then created_at (oldest first)
    const sortBy = [
      { field: 'preferred_window', direction: 'asc' },
      { field: 'created_at',       direction: 'asc' }
    ];

    const records = await listAirtable(apiUrl, filterFormula, sortBy);

    // Base order projection (keep old shape)
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
        // NEW: pass through if you already store a driver on the order
        driver:            f.driver || f.Driver || ''
      };
    });

    // -------- Driver suggestions (no writes here) --------
    // If DriverCaps/Slots are configured, pre-suggest a driver per window
    const suggestionResult = await suggestDriversForDate(date, orders);
    const drivers = suggestionResult.drivers; // union of drivers with caps
    const byKey = suggestionResult.byKey;     // map id -> suggested driver

    const enriched = orders.map(o => ({
      ...o,
      suggested_driver: o.driver ? '' : (byKey[o.id] || '') // only suggest if not already assigned
    }));

    return res.status(200).json({
      ok:true,
      date,
      count: enriched.length,
      orders: enriched,
      // NEW: drivers list so the UI can render a dropdown
      drivers
    });
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

/* ---------------- Driver suggestion helpers ---------------- */

async function suggestDriversForDate(date, orders){
  const key  = process.env.AIRTABLE_API_KEY;
  const base = process.env.AIRTABLE_BASE_ID;
  const driverCapsTable = process.env.AIRTABLE_TABLE_DRIVER_CAPS || 'DriverCaps';
  const slotsTable      = process.env.AIRTABLE_TABLE_SLOTS       || 'Slots';

  // If not configured, return no-op
  if (!key || !base) return { drivers: [], byKey: {} };

  // Which windows do we need to consider?
  const windows = Array.from(new Set(orders.map(o => o.preferred_window).filter(Boolean)));

  // Load caps and usage per window
  const capsPerWindow = {};
  const usagePerWindow = {};
  const allDrivers = new Set();

  for (const w of windows){
    capsPerWindow[w]  = await loadDriverCaps(base, key, driverCapsTable, date, w);
    usagePerWindow[w] = await loadDriverUsage(base, key, slotsTable, date, w);
    Object.keys(capsPerWindow[w]).forEach(d => allDrivers.add(d));
  }

  // Simulate assigning one "unit" per order to the least-loaded driver with remaining capacity.
  // (We only *suggest* here; the real write happens on Approve.)
  const byKey = {};
  for (const w of windows){
    const caps = capsPerWindow[w];
    const usage = { ...(usagePerWindow[w] || {}) };
    const group = orders.filter(o => o.preferred_window === w);

    for (const o of group){
      if (o.driver) continue; // already assigned
      const pick = pickDriverFrom(caps, usage, 1);
      if (pick){
        byKey[o.id] = pick;
        usage[pick] = (usage[pick] || 0) + 1; // consume simulated capacity
      }
    }
  }

  return { drivers: Array.from(allDrivers).sort(), byKey };
}

async function loadDriverCaps(base, key, driverCapsTable, date, window){
  const f = encodeURIComponent(`AND({Date}='${date}',{Window}='${window}')`);
  const url = `https://api.airtable.com/v0/${base}/${encodeURIComponent(driverCapsTable)}?filterByFormula=${f}&pageSize=100`;
  const r = await fetch(url, { headers:{ Authorization:'Bearer ' + key } });
  if (!r.ok) return {};
  const j = await r.json();
  const caps = {};
  for (const rec of (j.records || [])){
    const d = String(rec.fields?.Driver || '').trim();
    const c = Number(rec.fields?.Capacity || 0);
    if (d) caps[d] = Number.isFinite(c) ? c : 0;
  }
  return caps;
}

async function loadDriverUsage(base, key, slotsTable, date, window){
  const sinceIso = new Date(Date.now() - (Number(process.env.PENDING_FRESH_MIN || 60))*60*1000).toISOString();
  const filter = [
    `{Date}='${date}'`,
    `{Window}='${window}'`,
    `OR({Status}='confirmed', AND({Status}='pending', IS_AFTER({Updated}, '${sinceIso}')))` ,
    'NOT({AdminHold}=1)'
  ].join(',');
  const formula = `AND(${filter})`;
  let offset, usage = {};
  do{
    const u = new URL(`https://api.airtable.com/v0/${base}/${encodeURIComponent(slotsTable)}`);
    u.searchParams.set('filterByFormula', formula);
    u.searchParams.set('pageSize','100');
    if (offset) u.searchParams.set('offset', offset);
    const r = await fetch(u.toString(), { headers:{ Authorization:'Bearer ' + key } });
    if (!r.ok) break;
    const j = await r.json();
    for (const rec of (j.records || [])){
      const f = rec.fields || {};
      const n = Number(f.Items || 0); if (!Number.isFinite(n)) continue;
      const drv = String(f.Driver || '').trim() || '(unassigned)';
      usage[drv] = (usage[drv] || 0) + n;
    }
    offset = j.offset;
  } while (offset);
  return usage;
}

function pickDriverFrom(caps, usage, qtyNeeded){
  let best = null, bestLoad = Infinity;
  for (const d of Object.keys(caps || {})){
    const load   = usage?.[d] || 0;
    const remain = (caps?.[d] || 0) - load;
    if (remain >= (qtyNeeded || 1) && load < bestLoad){
      best = d; bestLoad = load;
    }
  }
  return best;
}
