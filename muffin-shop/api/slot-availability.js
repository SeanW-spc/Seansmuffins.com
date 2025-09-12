// api/slot-availability.js
// Returns which delivery windows are available for a given date, based on Airtable "Slots" + "SlotCaps".
// Output shape matches app.js expectations: { date, windows: { "6:00–7:00 AM": { capacity, current, available }, ... } }

function hasAirtableConfig() {
  return Boolean(
    process.env.AIRTABLE_API_KEY &&
    process.env.AIRTABLE_BASE_ID &&
    (process.env.AIRTABLE_TABLE_SLOTS || 'Slots')
  );
}

function getWindows() {
  return ['6:00–7:00 AM', '7:00–8:00 AM', '8:00–9:00 AM'];
}

const DEF_CAP = Number(process.env.SLOT_CAPACITY_DEFAULT || 5);

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
  }

  const date = String(req.query?.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'date (YYYY-MM-DD) required' });
  }

  // No Airtable? Assume all open with default capacity.
  if (!hasAirtableConfig()) {
    const windows = {};
    for (const w of getWindows()) {
      windows[w] = { capacity: DEF_CAP, current: 0, available: DEF_CAP };
    }
    return res.status(200).json({ date, windows });
  }

  try {
    const wins = getWindows();
    const windows = {};
    for (const w of wins) {
      const [cap, cur] = await Promise.all([
        resolveCapacity(date, w),
        countOccupied(date, w)
      ]);
      const available = Math.max(0, cap - cur);
      windows[w] = { capacity: cap, current: cur, available };
    }
    return res.status(200).json({ date, windows });
  } catch (err) {
    console.error('slot-availability error', err?.message || err);
    // Soft fail: if Airtable hiccups, don't block user; show all as available
    const windows = {};
    for (const w of getWindows()) {
      windows[w] = { capacity: DEF_CAP, current: 0, available: DEF_CAP };
    }
    return res.status(200).json({ date, windows });
  }
}

/* ---------------- Helpers ---------------- */

async function resolveCapacity(date, win) {
  const base = process.env.AIRTABLE_BASE_ID;
  const key  = process.env.AIRTABLE_API_KEY;
  const table = encodeURIComponent(process.env.AIRTABLE_TABLE_SLOT_CAPS || 'SlotCaps');
  const u = new URL(`https://api.airtable.com/v0/${base}/${table}`);
  u.searchParams.set('filterByFormula', `AND({Date}='${date}', {Window}='${win}')`);
  const r = await fetch(u.toString(), { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) return DEF_CAP;
  const j = await r.json();
  const rec = (j.records || [])[0];
  const cap = Number(rec?.fields?.Capacity);
  return Number.isFinite(cap) ? cap : DEF_CAP;
}

async function countOccupied(date, win) {
  const base = process.env.AIRTABLE_BASE_ID;
  const key  = process.env.AIRTABLE_API_KEY;
  const table = encodeURIComponent(process.env.AIRTABLE_TABLE_SLOTS || 'Slots');
  const url   = `https://api.airtable.com/v0/${base}/${table}`;

  // Count confirmed + pending holds updated in the last 60 minutes, summing the Items field
  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const formula = `AND({Date}='${date}', {Window}='${win}', OR({Status}='confirmed', AND({Status}='pending', IS_AFTER({Updated}, '${cutoff}'))))`;

  let offset = null, totalItems = 0;
  do {
    const q = new URL(url);
    q.searchParams.set('pageSize', '100');
    q.searchParams.set('filterByFormula', formula);
    if (offset) q.searchParams.set('offset', offset);

    const r = await fetch(q.toString(), { headers: { Authorization: `Bearer ${key}` } });
    if (!r.ok) break;
    const data = await r.json();

    totalItems += (data.records || []).reduce((sum, rec) => {
      const n = Number(rec?.fields?.Items || 0);
      return sum + (Number.isFinite(n) ? n : 0);
    }, 0);

    offset = data.offset;
  } while (offset);

  return totalItems;
}
