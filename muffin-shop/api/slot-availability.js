// /api/slot-availability.js
// GET ?date=YYYY-MM-DD[&detailed=1]
// Returns: { date, windows: { "<win>": { capacity, current, available, sold_out, drivers? } } }

function withCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  return false;
}

const FRESH_MINUTES = Number(process.env.PENDING_FRESH_MIN || 60);

// Canonical labels (EN–DASH + AM)
function getWindows() {
  const env = (process.env.WINDOWS_LIST || '').trim();
  if (env) return env.split(',').map(s => s.trim()).filter(Boolean);
  return ['6:00–7:00 AM','7:00–8:00 AM','8:00–9:00 AM'];
}

const normDash = s => String(s||'').replace(/–|—/g,'-').trim();
const hasAirtable = !!(process.env.AIRTABLE_API_KEY && process.env.AIRTABLE_BASE_ID);

async function readAll(url, headers) {
  let out = [], offset;
  do {
    const u = new URL(url);
    if (offset) u.searchParams.set('offset', offset);
    const r = await fetch(u.toString(), { headers });
    if (!r.ok) break;
    const j = await r.json();
    (j.records || []).forEach(rec => out.push(rec.fields || {}));
    offset = j.offset;
  } while (offset);
  return out;
}

async function resolveCapacity(date, win) {
  if (!hasAirtable) return Number(process.env.SLOT_CAPACITY_DEFAULT || 5);
  const key  = process.env.AIRTABLE_API_KEY;
  const base = process.env.AIRTABLE_BASE_ID;
  const slotTbl   = encodeURIComponent(process.env.AIRTABLE_TABLE_SLOT_CAPS   || 'SlotCaps');
  const driverTbl = encodeURIComponent(process.env.AIRTABLE_TABLE_DRIVER_CAPS || 'DriverCaps');

  // Slot override (optional)
  let slotCap = null;
  {
    const u = new URL(`https://api.airtable.com/v0/${base}/${slotTbl}`);
    u.searchParams.set('filterByFormula', `AND({Date}='${date}',{Window}='${win}')`);
    u.searchParams.set('maxRecords','1');
    const r = await fetch(u.toString(), { headers: { Authorization: 'Bearer ' + key } });
    if (r.ok) {
      const j = await r.json();
      const rec = (j.records || [])[0];
      if (rec && rec.fields && rec.fields.Capacity != null) {
        const n = Number(rec.fields.Capacity);
        if (Number.isFinite(n)) slotCap = n;
      }
    }
  }

  // Per-driver caps (if any exist, they define total)
  let perDriverSum = 0, foundDriverCaps = false;
  {
    const f = encodeURIComponent(`AND({Date}='${date}',{Window}='${win}')`);
    const u = `https://api.airtable.com/v0/${base}/${driverTbl}?filterByFormula=${f}&pageSize=100`;
    const r = await fetch(u, { headers:{ Authorization:'Bearer ' + key } });
    if (r.ok) {
      const j = await r.json();
      for (const rec of (j.records || [])) {
        const n = Number(rec.fields?.Capacity || 0);
        if (Number.isFinite(n)) { perDriverSum += n; foundDriverCaps = true; }
      }
    }
  }

  if (foundDriverCaps) return perDriverSum;
  if (slotCap != null) return slotCap;
  return Number(process.env.SLOT_CAPACITY_DEFAULT || 12);
}

// Confirmed + fresh pending + AdminHold
async function countOccupied(date, win) {
  if (!hasAirtable) return 0;
  const key  = process.env.AIRTABLE_API_KEY;
  const base = process.env.AIRTABLE_BASE_ID;
  const slotsTbl = encodeURIComponent(process.env.AIRTABLE_TABLE_SLOTS || 'Slots');

  const sinceIso = new Date(Date.now() - FRESH_MINUTES*60*1000).toISOString();
  const filter = [
    `{Date}='${date}'`,
    `{Window}='${win}'`,
    `OR({Status}='confirmed',AND({Status}='pending',{Updated}>='${sinceIso}'),{AdminHold}=1)`
  ].join(',');
  const formula = `AND(${filter})`;

  const u0 = `https://api.airtable.com/v0/${base}/${slotsTbl}?filterByFormula=${encodeURIComponent(formula)}&pageSize=100`;
  const rows = await readAll(u0, { Authorization:'Bearer ' + key });

  let total = 0;
  for (const f of rows) total += Number(f.Items || 0) || 0;
  return total;
}

async function perDriverBreakdown(date, win) {
  if (!hasAirtable) return {};
  const key  = process.env.AIRTABLE_API_KEY;
  const base = process.env.AIRTABLE_BASE_ID;
  const capsTbl  = encodeURIComponent(process.env.AIRTABLE_TABLE_DRIVER_CAPS || 'DriverCaps');
  const slotsTbl = encodeURIComponent(process.env.AIRTABLE_TABLE_SLOTS      || 'Slots');

  // Capacities
  const fCaps = encodeURIComponent(`AND({Date}='${date}',{Window}='${win}')`);
  const capsRows = await readAll(`https://api.airtable.com/v0/${base}/${capsTbl}?filterByFormula=${fCaps}&pageSize=100`,
    { Authorization:'Bearer ' + key });
  const caps = {};
  for (const f of capsRows) {
    const d = String(f.Driver || '').trim();
    const c = Number(f.Capacity || 0);
    if (d && Number.isFinite(c)) caps[d] = (caps[d] || 0) + c;
  }

  // Current usage (confirmed + fresh pending, ignore AdminHold)
  const sinceIso = new Date(Date.now() - FRESH_MINUTES*60*1000).toISOString();
  const filter = [
    `{Date}='${date}'`,
    `{Window}='${win}'`,
    `OR({Status}='confirmed',AND({Status}='pending',{Updated}>='${sinceIso}'))`
  ].join(',');
  const formula = `AND(${filter})`;
  const slotRows = await readAll(`https://api.airtable.com/v0/${base}/${slotsTbl}?filterByFormula=${encodeURIComponent(formula)}&pageSize=100`,
    { Authorization:'Bearer ' + key });
  const current = {};
  for (const f of slotRows) {
    if (f.AdminHold) continue;
    const d = String(f.Driver || '').trim();
    const n = Number(f.Items || 0);
    if (d && Number.isFinite(n)) current[d] = (current[d] || 0) + n;
  }

  const out = {};
  for (const d of Object.keys(caps)) {
    const cap = caps[d] || 0;
    const cur = current[d] || 0;
    const avail = Math.max(0, cap - cur);
    out[d] = { capacity: cap, current: cur, available: avail, sold_out: avail <= 0 };
  }
  return out;
}

export default async function handler(req, res) {
  if (withCors(req, res)) return;
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow','GET,OPTIONS');
      return res.status(405).json({ error:'method_not_allowed' });
    }
    const date = String(req.query.date || '').trim();
    const wantDetailed = String(req.query.detailed || '').trim() === '1';

    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)) {
      return res.status(400).json({ error:'invalid_date' });
    }

    // Build canonical EN–DASH windows
    const windows = {};
    for (const w of getWindows()) windows[w] = { capacity: 0, current: 0, available: 0, sold_out: false, ...(wantDetailed ? {drivers:{}} : {}) };

    if (!hasAirtable) {
      const def = Number(process.env.SLOT_CAPACITY_DEFAULT || 5);
      for (const w of Object.keys(windows)) {
        windows[w].capacity = def;
        windows[w].available = def;
      }
      return res.status(200).json({ date, windows });
    }

    for (const w of Object.keys(windows)) {
      const cap = await resolveCapacity(date, w);
      const cur = await countOccupied(date, w);
      const avail = Math.max(0, cap - cur);
      windows[w].capacity = cap;
      windows[w].current  = cur;
      windows[w].available= avail;
      windows[w].sold_out = avail <= 0;
      if (wantDetailed) windows[w].drivers = await perDriverBreakdown(date, w);
    }

    return res.status(200).json({ date, windows });
  } catch (err) {
    console.error('slot-availability error', err);
    return res.status(500).json({ error:'server_error' });
  }
}
