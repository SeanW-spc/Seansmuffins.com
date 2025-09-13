// /api/slot-availability.js
// GET ?date=YYYY-MM-DD[&detailed=1]
// Returns: { date, windows: { "<win>": { capacity, current, available, sold_out, drivers? } } }

function withCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Token');
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  return false;
}

// Canonical windows (use EN–DASH)
const WINDOWS = ['6:00–7:00 AM','7:00–8:00 AM','8:00–9:00 AM'];

const FRESH_MIN = Number(process.env.PENDING_FRESH_MIN || 60);
const hasAirtable = !!(process.env.AIRTABLE_API_KEY && process.env.AIRTABLE_BASE_ID);

const dashVariants = (win) => {
  const en = String(win || '').replace(/-/g, '–'); // ensure en-dash form
  const hy = en.replace(/–|—/g, '-');             // plain hyphen variant
  return [en, hy];
};

async function readAll(u, headers) {
  const url = typeof u === 'string' ? new URL(u) : new URL(u.toString());
  const out = [];
  let offset;
  do {
    const cur = new URL(url);
    if (offset) cur.searchParams.set('offset', offset);
    const r = await fetch(cur.toString(), { headers });
    if (!r.ok) break;
    const j = await r.json();
    (j.records || []).forEach(rec => out.push(rec.fields || {}));
    offset = j.offset;
  } while (offset);
  return out;
}

async function perWindowDriverCaps(date, win) {
  // Sum DriverCaps for (date, window)
  const key  = process.env.AIRTABLE_API_KEY;
  const base = process.env.AIRTABLE_BASE_ID;
  const capsTbl  = encodeURIComponent(process.env.AIRTABLE_TABLE_DRIVER_CAPS || 'DriverCaps');

  const [en, hy] = dashVariants(win);
  const filter = `AND({Date}='${date}', OR({Window}='${en}', {Window}='${hy}'))`;
  const url = `https://api.airtable.com/v0/${base}/${capsTbl}?filterByFormula=${encodeURIComponent(filter)}&pageSize=100`;

  const rows = await readAll(url, { Authorization: 'Bearer ' + key });

  const capsByDriver = {};
  let foundAny = false;
  for (const f of rows) {
    const d = String(f.Driver || '').trim();
    const n = Number(f.Capacity || 0);
    if (!d || !Number.isFinite(n)) continue;
    capsByDriver[d] = (capsByDriver[d] || 0) + n;
    foundAny = true;
  }
  const totalCap = Object.values(capsByDriver).reduce((a,b)=>a+(Number(b)||0),0);
  return { foundAny, capsByDriver, totalCap };
}

async function windowUsage(date, win) {
  // Count confirmed + fresh pending + AdminHold (for TOTAL),
  // and per-driver confirmed + fresh pending (ignore AdminHold per driver)
  const key  = process.env.AIRTABLE_API_KEY;
  const base = process.env.AIRTABLE_BASE_ID;
  const slotsTbl = encodeURIComponent(process.env.AIRTABLE_TABLE_SLOTS || 'Slots');

  const [en, hy] = dashVariants(win);
  const sinceIso = new Date(Date.now() - FRESH_MIN*60*1000).toISOString();

  const formula = `AND(
    {Date}='${date}',
    OR({Window}='${en}', {Window}='${hy}'),
    OR(
      {Status}='confirmed',
      AND({Status}='pending', IS_AFTER({Updated}, '${sinceIso}')),
      {AdminHold}=1
    )
  )`;

  const url = `https://api.airtable.com/v0/${base}/${slotsTbl}?filterByFormula=${encodeURIComponent(formula)}&pageSize=100`;

  const rows = await readAll(url, { Authorization: 'Bearer ' + key });

  let totalCurrent = 0;
  const perDriverCurrent = {};
  for (const f of rows) {
    const n = Number(f.Items || 0) || 0;
    totalCurrent += n; // includes AdminHold in TOTAL
    if (f.AdminHold) continue; // but do not assign AdminHold to a driver
    const d = String(f.Driver || '').trim();
    if (d) perDriverCurrent[d] = (perDriverCurrent[d] || 0) + n;
  }
  return { totalCurrent, perDriverCurrent };
}

export default async function handler(req, res) {
  if (withCors(req, res)) return;
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow','GET,OPTIONS');
      return res.status(405).json({ error:'method_not_allowed' });
    }

    const date = String(req.query.date || '').trim();
    const wantDetailed = ['1','true','yes'].includes(String(req.query.detailed || '').toLowerCase());

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error:'invalid_date' });
    }

    // Initialize canonical window keys with EN–DASH labels
    const windows = {};
    for (const w of WINDOWS) {
      windows[w] = { capacity: 0, current: 0, available: 0, sold_out: true };
      if (wantDetailed) windows[w].drivers = {};
    }

    if (!hasAirtable) {
      // No Airtable configured -> capacity must be 0 (driver-only policy)
      return res.status(200).json({ date, windows });
    }

    for (const w of WINDOWS) {
      const [{ foundAny, capsByDriver, totalCap }, { totalCurrent, perDriverCurrent }] =
        await Promise.all([ perWindowDriverCaps(date, w), windowUsage(date, w) ]);

      // Driver-only: if no caps for this window, capacity = 0
      const capacity = foundAny ? totalCap : 0;
      const available = Math.max(0, capacity - totalCurrent);
      const sold_out = available <= 0;

      windows[w].capacity = capacity;
      windows[w].current  = totalCurrent;
      windows[w].available= available;
      windows[w].sold_out = sold_out;

      if (wantDetailed) {
        const drivers = {};
        // Include all drivers that have caps for this window
        for (const [d, cap] of Object.entries(capsByDriver)) {
          const cur = Number(perDriverCurrent[d] || 0);
          const av  = Math.max(0, Number(cap||0) - cur);
          drivers[d] = { capacity: Number(cap||0), current: cur, available: av, sold_out: av <= 0 };
        }
        windows[w].drivers = drivers;
      }
    }

    return res.status(200).json({ date, windows });
  } catch (err) {
    console.error('slot-availability error', err);
    return res.status(500).json({ error:'server_error' });
  }
}
