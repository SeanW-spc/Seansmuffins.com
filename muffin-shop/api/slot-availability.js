// api/slot-availability.js (driver-aware)
// Returns availability for a given date.
// If ?detailed=1, also includes per-driver breakdown: windows[win].drivers[driver] = { capacity, current, available }

function getWindows(){ return ['6:00–7:00 AM','7:00–8:00 AM','8:00–9:00 AM']; }
const FRESH_MINUTES = Number(process.env.PENDING_FRESH_MIN || 60);

export default async function handler(req, res){
  try{
    if (req.method !== 'GET'){ res.setHeader('Allow','GET'); return res.status(405).json({ error:'method_not_allowed' }); }
    const date = String(req.query?.date || '').trim();
    const detailed = String(req.query?.detailed || '') === '1';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error:'invalid_date' });

    if (!process.env.AIRTABLE_API_KEY || !process.env.AIRTABLE_BASE_ID){
      const def = Number(process.env.SLOT_CAPACITY_DEFAULT || 5);
      const windows = Object.fromEntries(getWindows().map(w => [w, { capacity:def, current:0, available:def, ...(detailed?{drivers:{}}:{}) }]));
      return res.status(200).json({ date, windows });
    }

    const out = {};
    for (const w of getWindows()){
      const [cap, perDriverCaps] = await resolveCapacityWithDrivers(date, w);
      const { totalCurrent, perDriverCurrent } = await countOccupiedWithDrivers(date, w);

      const available = Math.max(0, cap - totalCurrent);
      const row = { capacity: cap, current: totalCurrent, available };
      if (detailed){
        row.drivers = {};
        const allDrivers = new Set(Object.keys(perDriverCaps).concat(Object.keys(perDriverCurrent)));
        for (const d of allDrivers){
          const dc = perDriverCaps[d] ?? 0;
          const cur= perDriverCurrent[d] ?? 0;
          row.drivers[d] = { capacity: dc, current: cur, available: Math.max(0, dc - cur) };
        }
      }
      out[w] = row;
    }
    return res.status(200).json({ date, windows: out });
  }catch(err){
    console.error('slot-availability error', err);
    return res.status(500).json({ error:'server_error' });
  }
}

// ----- Airtable helpers -----
async function resolveCapacityWithDrivers(date, window){
  const key = process.env.AIRTABLE_API_KEY;
  const base= process.env.AIRTABLE_BASE_ID;
  const slotCapsTable = process.env.AIRTABLE_TABLE_SLOT_CAPS || 'SlotCaps';
  const driverCapsTable= process.env.AIRTABLE_TABLE_DRIVER_CAPS || 'DriverCaps';
  const def = Number(process.env.SLOT_CAPACITY_DEFAULT || 5);

  const slotCap = await getSingleNumber(base, slotCapsTable, `AND({Date}='${date}',{Window}='${window}')`, 'Capacity', key);
  const perDriverCaps = await getDriverCaps(base, driverCapsTable, date, window, key);

  let cap = slotCap ?? def;
  if (Object.keys(perDriverCaps).length){
    cap = Object.values(perDriverCaps).reduce((a,b)=>a+Number(b||0), 0);
  }
  return [cap, perDriverCaps];
}

async function countOccupiedWithDrivers(date, window){
  const key = process.env.AIRTABLE_API_KEY;
  const base= process.env.AIRTABLE_BASE_ID;
  const slotsTable = process.env.AIRTABLE_TABLE_SLOTS || 'Slots';
  const sinceIso = new Date(Date.now() - FRESH_MINUTES*60*1000).toISOString();

  // Count confirmed + fresh pending + admin holds (holds are counted in total, but not credited to a driver)
  const filter = [
    `{Date}='${date}'`,
    `{Window}='${window}'`,
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
        const driver = String(f.Driver || '').trim();
        if (driver) perDriver[driver] = (perDriver[driver] || 0) + n;
      }
    }
    offset = j.offset;
  } while (offset);

  return { totalCurrent: total, perDriverCurrent: perDriver };
}

async function getSingleNumber(base, table, andFormula, field, key){
  const u = new URL(`https://api.airtable.com/v0/${base}/${encodeURIComponent(table)}`);
  u.searchParams.set('filterByFormula', andFormula);
  u.searchParams.set('maxRecords', '1');
  const r = await fetch(u.toString(), { headers: { Authorization: 'Bearer ' + key } });
  if (!r.ok) return null;
  const j = await r.json();
  const rec = (j.records || [])[0];
  const n = rec ? Number(rec.fields?.[field] || 0) : null;
  return Number.isFinite(n) ? n : null;
}

async function getDriverCaps(base, table, date, window, key){
  const out = {};
  const f = encodeURIComponent(`AND({Date}='${date}',{Window}='${window}')`);
  const u = new URL(`https://api.airtable.com/v0/${base}/${encodeURIComponent(table)}?filterByFormula=${f}`);
  const r = await fetch(u.toString(), { headers: { Authorization: 'Bearer ' + key } });
  if (!r.ok) return out;
  const j = await r.json();
  for (const rec of (j.records || [])){
    const flds = rec.fields || {};
    const driver = String(flds.Driver || '').trim();
    if (!driver) continue;
    const cap = Math.max(0, Number(flds.Capacity || 0));
    out[driver] = cap;
  }
  return out;
}
