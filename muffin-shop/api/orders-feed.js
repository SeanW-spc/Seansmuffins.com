// api/orders-feed.js
// Secure JSON feed of orders for a given date/status + CORS.
// Auth: Authorization: Bearer <ADMIN_API_TOKEN>  (also supports x-admin-token and ?token=)
// Field-name tolerant (snake_case OR Title Case). Falls back to client-side filtering/sorting.

function withCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Token');
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  return false;
}

function getAdminToken(req) {
  const auth = (req.headers.authorization || '').trim();
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7);
  const hdr = (req.headers['x-admin-token'] || '').toString().trim();
  if (hdr) return hdr;
  const q = (req.query && req.query.token) ? String(req.query.token) : '';
  if (q) return q;
  try { if (req.body && typeof req.body === 'object' && req.body.token) return String(req.body.token); } catch {}
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
    const headers = { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` };

    // Inputs
    const today = new Date().toISOString().slice(0,10);
    const date = String(req.query.date || today);
    const statusFilter = (req.query.status ? String(req.query.status) : '').trim();

    // --- tolerant date filtering (server-side if possible, else client-side) ---
    const dateFieldCandidates = ['delivery_date', 'Delivery Date', 'Date'];
    const records = await listAirtableByDateTolerant(apiUrl, headers, date, dateFieldCandidates);

    // Helper to select first present field
    const pick = (fields, names, fallback='') => {
      for (const n of names) {
        if (Object.prototype.hasOwnProperty.call(fields, n) && fields[n] != null) return fields[n];
      }
      return fallback;
    };

    // Client-side filter by date (in case we had to fall back to unfiltered fetch)
    const sameDate = (v) => String(v || '').slice(0,10) === date;
    const filteredByDate = records.filter(r => sameDate(pick(r.fields || {}, dateFieldCandidates)));

    // Optional status filter (tolerant)
    const statusNames = ['status', 'Status'];
    const filtered = statusFilter
      ? filteredByDate.filter(r => {
          const v = String(pick(r.fields || {}, statusNames, '')).toLowerCase();
          return v === statusFilter.toLowerCase();
        })
      : filteredByDate;

    // Sort locally: window then created
    const winNames = ['preferred_window', 'Preferred Window', 'Window'];
    const createdNames = ['created_at', 'Created', 'Created At'];
    filtered.sort((a,b) => {
      const fa = a.fields || {}, fb = b.fields || {};
      const wa = String(pick(fa, winNames, '')), wb = String(pick(fb, winNames, ''));
      const ca = String(pick(fa, createdNames, '')), cb = String(pick(fb, createdNames, ''));
      return wa.localeCompare(wb) || ca.localeCompare(cb);
    });

    // Shape response objects (tolerant field mapping)
    const orders = filtered.map(r => {
      const f = r.fields || {};
      return {
        id: r.id,
        delivery_date:     pick(f, ['delivery_date','Delivery Date','Date'], ''),
        preferred_window:  pick(f, ['preferred_window','Preferred Window','Window'], ''),
        status:            pick(f, ['status','Status'], ''),
        delivery_time:     pick(f, ['delivery_time','Delivery Time'], ''),
        route_position:    pick(f, ['route_position','Route Position'], null),
        customer_name:     pick(f, ['customer_name','Customer Name','Name'], ''),
        email:             pick(f, ['email','Email'], ''),
        phone:             pick(f, ['phone','Phone'], ''),
        address:           pick(f, ['address','Address'], ''),
        notes:             pick(f, ['notes','Notes'], ''),
        total:             pick(f, ['total','Total'], null),
        items:             pick(f, ['items','Items'], ''),
        stripe_session_id: pick(f, ['stripe_session_id','Stripe Session ID','Session ID'], ''),
        created_at:        pick(f, ['created_at','Created','Created At'], ''),
        driver:            pick(f, ['driver','Driver'], '')
      };
    });

    // --- Driver suggestions (read-only; real write happens on approve) ---
    const suggestionResult = await suggestDriversForDate(date, orders);
    const drivers = suggestionResult.drivers;
    const byKey = suggestionResult.byKey;

    const enriched = orders.map(o => ({
      ...o,
      suggested_driver: o.driver ? '' : (byKey[o.id] || '')
    }));

    return res.status(200).json({ ok:true, date, count: enriched.length, orders: enriched, drivers });
  } catch (err) {
    console.error('orders-feed error', err?.message || err);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
}

/* ---------------- Airtable listing (tolerant) ---------------- */

async function listAirtableByDateTolerant(baseUrl, headers, date, dateFieldCandidates){
  // Try server-side filtering with each candidate field; on failure, fall back to no filter.
  for (const field of dateFieldCandidates) {
    try {
      const f = `AND({${field}}='${date}')`;
      const recs = await listAirtable(baseUrl, headers, f);
      // If this worked, use it.
      return recs;
    } catch (e) {
      // Unknown field name or formula error – try next candidate
      continue;
    }
  }
  // Fallback: fetch without filter and let caller filter client-side.
  try { return await listAirtable(baseUrl, headers, null); } catch { return []; }
}

async function listAirtable(baseUrl, headers, filterByFormula /* or null */) {
  let offset = null, out = [];
  do {
    const u = new URL(baseUrl);
    u.searchParams.set('pageSize', '100');
    if (filterByFormula) u.searchParams.set('filterByFormula', filterByFormula);
    if (offset) u.searchParams.set('offset', offset);
    const r = await fetch(u.toString(), { headers });
    if (!r.ok) {
      const txt = await safeText(r);
      throw new Error(`Airtable list ${r.status}: ${txt}`);
    }
    const j = await r.json();
    out.push(...(j.records || []));
    offset = j.offset;
  } while (offset);
  return out;
}

async function safeText(r){ try { return await r.text(); } catch { return ''; } }

/* ---------------- Driver suggestion helpers ---------------- */

async function suggestDriversForDate(date, orders){
  const key  = process.env.AIRTABLE_API_KEY;
  const base = process.env.AIRTABLE_BASE_ID;
  const driverCapsTable = process.env.AIRTABLE_TABLE_DRIVER_CAPS || 'DriverCaps';
  const slotsTable      = process.env.AIRTABLE_TABLE_SLOTS       || 'Slots';

  if (!key || !base) return { drivers: [], byKey: {} };

  const windows = Array.from(new Set(orders.map(o => o.preferred_window).filter(Boolean)));

  const capsPerWindow = {};
  const usagePerWindow = {};
  const allDrivers = new Set();

  for (const w of windows){
    capsPerWindow[w]  = await loadDriverCaps(base, key, driverCapsTable, date, w);
    usagePerWindow[w] = await loadDriverUsage(base, key, slotsTable, date, w);
    Object.keys(capsPerWindow[w]).forEach(d => allDrivers.add(d));
  }

  const byKey = {};
  for (const w of windows){
    const caps = capsPerWindow[w];
    const usage = { ...(usagePerWindow[w] || {}) };
    const group = orders.filter(o => o.preferred_window === w);

    for (const o of group){
      if (o.driver) continue;
      const pick = pickDriverFrom(caps, usage, 1);
      if (pick){
        byKey[o.id] = pick;
        usage[pick] = (usage[pick] || 0) + 1;
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
    `OR({Status}='confirmed', AND({Status}='pending', IS_AFTER({Updated}, '${sinceIso}')))`,
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
