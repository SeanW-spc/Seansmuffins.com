// api/slot-availability.js (driver-aware, CORS, configurable windows)
// GET ?date=YYYY-MM-DD[&detailed=1]
// Returns { date, windows: { "<win>": { capacity, current, available, sold_out, drivers? } } }

function withCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  return false;
}

const FRESH_MINUTES = Number(process.env.PENDING_FRESH_MIN || 60);
const normDash = s => String(s||'').replace(/–|—/g,'-').trim();

function getWindows(){
  const raw = process.env.DELIVERY_WINDOWS || process.env.NEXT_PUBLIC_DELIVERY_WINDOWS || '';
  const fromEnv = raw.split(/[|,]/).map(s => s.trim()).filter(Boolean);
  return (fromEnv.length ? fromEnv : ['6:00–7:00 AM','7:00–8:00 AM','8:00–9:00 AM']).map(normDash);
}

export default async function handler(req, res){
  if (withCors(req, res)) return;
  try{
    if (req.method !== 'GET'){ res.setHeader('Allow','GET,OPTIONS'); return res.status(405).json({ error:'method_not_allowed' }); }
    const date = String(req.query?.date || '').trim();
    const detailed = String(req.query?.detailed || '') === '1';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error:'invalid_date' });

    // No Airtable configured → static defaults
    if (!process.env.AIRTABLE_API_KEY || !process.env.AIRTABLE_BASE_ID){
      const def = Number(process.env.SLOT_CAPACITY_DEFAULT || 5);
      const windows = Object.fromEntries(getWindows().map(w => [w, {
        capacity:def, current:0, available:def, sold_out:false, ...(detailed?{drivers:{}}:{})
      }]));
      return res.status(200).json({ date, windows });
    }

    // Build all windows in parallel
    const names = getWindows();
    const pairs = await Promise.all(names.map(async (w) => {
      const [cap, perDriverCaps, occ] = await Promise.all([
        resolveCapacityWithDrivers(date, w),
        getDriverCaps(date, w),
        countOccupiedWithDrivers(date, w)
      ]).then(([c, d, o]) => [c, d, o]);

      // cap: prefer per-driver sum if any driver caps exist; else SlotCaps/default
      const totalCap = Object.keys(perDriverCaps).length
        ? Object.values(perDriverCaps).reduce((a,b)=>a+Number(b||0), 0)
        : (cap ?? Number(process.env.SLOT_CAPACITY_DEFAULT || 5));

      const totalCur = occ.totalCurrent;
      const available = Math.max(0, totalCap - totalCur);

      const row = { capacity: totalCap, current: totalCur, available, sold_out: available <= 0 };
      if (detailed){
        row.drivers = {};
        const all = new Set([...Object.keys(perDriverCaps), ...Object.keys(occ.perDriverCurrent)]);
        for (const d of all){
          const dc = perDriverCaps[d] ?? 0;
          const cur= occ.perDriverCurrent[d] ?? 0;
          row.drivers[d] = { capacity: dc, current: cur, available: Math.max(0, dc - cur) };
        }
      }
      return [w, row];
    }));

    return res.status(200).json({ date, windows: Object.fromEntries(pairs) });
  }catch(err){
    console.error('slot-availability error', err);
    return res.status(500).json({ error:'server_error' });
  }
}

/* ---------------- Airtable helpers ---------------- */

async function resolveCapacityWithDrivers(date, window){
  const key  = process.env.AIRTABLE_API_KEY;
  const base = process.env.AIRTABLE_BASE_ID;
  const slotCapsTable = process.env.AIRTABLE_TABLE_SLOT_CAPS || 'SlotCaps';
  // Look for a SlotCaps override (used only when no per-driver caps exist)
  const u = new URL(`https://api.airtable.com/v0/${base}/${encodeURIComponent(slotCapsTable)}`);
  u.searchParams.set('filterByFormula', `AND({Date}='${date}',{Window}='${normDash(window)}')`);
  u.searchParams.set('maxRecords', '1');
  const r = await fetch(u.toString(), { headers: { Authorization: 'Bearer ' + key } });
  if (!r.ok) return null;
  const j = await r.json();
  const rec = (j.records || [])[0];
  const n = rec ? Number(rec.fields?.Capacity || 0) : null;
  return Number.isFinite(n) ? n : null;
}

async function getDriverCaps(date, window){
  const key  = process.env.AIRTABLE_API_KEY;
  const base = process.env.AIRTABLE_BASE_ID;
  const driverCapsTable= process.env.AIRTABLE_TABLE_DRIVER_CAPS || 'DriverCaps';
  const out = {};
  const f = encodeURIComponent(`AND({Date}='${date}',{Window}='${normDash(window)}')`);
  const url = `https://api.airtable.com/v0/${base}/${encodeURIComponent(driverCapsTable)}?filterByFormula=${f}&pageSize=100`;
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + key } });
  if (!r.ok) return out;
  const j = await r.json();
  for (const rec of (j.records || [])){
    const flds = rec.fields || {};
    const driver = (flds.Driver || '').toString().trim();
    if (!driver) continue;
    const cap = Math.max(0, Number(flds.Capacity || 0));
    out[driver] = cap;
  }
  return out;
}

async function countOccupiedWithDrivers(date, window){
  const key  = process.env.AIRTABLE_API_KEY;
  const base = process.env.AIRTABLE_BASE_ID;
  const slotsTable = process.env.AIRTABLE_TABLE_SLOTS || 'Slots';
  const sinceIso = new Date(Date.now() - FRESH_MINUTES*60*1000).toISOString();

  // Count confirmed + fresh pending + admin holds (holds count toward total, but not toward any driver's usage)
  const filter = [
    `{Date}='${date}'`,
    `{Window}='${normDash(window)}'`,
    `OR({Status}='confirmed', AND({Status}='pending', IS_AFTER({Updated}, '${sinceIso}')), {AdminHold}=1)`
  ].join(',');
  const formula = `AND(${filter})`;

  let offset, total = 0;
  const perDriver = {};
  do{
    const u = new URL(`https://api.airtable.com/v0/${base}/${encodeURIComponent(slotsTable)}`);
    u.searchParams.set('filterByFormula', formula);
    u.searchParams.set('pageSize', '100');
    if (offset) u.searchParams.set('offset', offset);
    const r = await fetch(u.toString(), { headers:{ Authorization: 'Bearer ' + key } });
    if (!r.ok) break;
    const j = await r.json();
    for (const rec of (j.records || [])){
      const f = rec.fields || {};
      const n = Number(f.Items || 0);
      if (!Number.isFinite(n)) continue;
      total += n;
      if (!f.AdminHold){
        const driver = (f.Driver || '').toString().trim();
        if (driver) perDriver[driver] = (perDriver[driver] || 0) + n;
      }
    }
    offset = j.offset;
  } while (offset);

  return { totalCurrent: total, perDriverCurrent: perDriver };
}