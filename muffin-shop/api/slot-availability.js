// Require driver caps; disallow orders if none exist (capacity = 0)
async function getDriverCapsAndLoad(date, windowLabel) {
  const key  = process.env.AIRTABLE_API_KEY;
  const base = process.env.AIRTABLE_BASE_ID;
  const capsTbl  = encodeURIComponent(process.env.AIRTABLE_TABLE_DRIVER_CAPS || 'DriverCaps');
  const slotsTbl = encodeURIComponent(process.env.AIRTABLE_TABLE_SLOTS || 'Slots');

  const enc = s => encodeURIComponent(s);
  // Caps
  const capsRows = await (async ()=>{
    const f = enc(`AND({Date}='${date}',{Window}='${windowLabel}')`);
    const url = `https://api.airtable.com/v0/${base}/${capsTbl}?filterByFormula=${f}&pageSize=100`;
    let out=[], offset, headers={ Authorization:'Bearer ' + key };
    do {
      const u = new URL(url);
      if (offset) u.searchParams.set('offset', offset);
      const r = await fetch(u, { headers }); if (!r.ok) break;
      const j = await r.json(); (j.records||[]).forEach(rec => out.push(rec.fields||{}));
      offset = j.offset;
    } while(offset);
    return out;
  })();

  const caps = {};
  let foundAny = false;
  capsRows.forEach(f => {
    const d = (f.Driver||'').toString().trim();
    const c = Number(f.Capacity||0);
    if (!d || !Number.isFinite(c)) return;
    foundAny = true;
    caps[d] = (caps[d] || 0) + c;
  });

  // Current usage (confirmed + fresh pending, ignore AdminHold for per-driver)
  const sinceIso = new Date(Date.now() - Number(process.env.PENDING_FRESH_MIN || 60)*60*1000).toISOString();
  const filter = `AND({Date}='${date}',{Window}='${windowLabel}',OR({Status}='confirmed',AND({Status}='pending',{Updated}>='${sinceIso}')))`;
  const slotsUrl = `https://api.airtable.com/v0/${base}/${slotsTbl}?filterByFormula=${enc(filter)}&pageSize=100`;
  let cur=[], offset, headers={ Authorization:'Bearer ' + key };
  do {
    const u = new URL(slotsUrl);
    if (offset) u.searchParams.set('offset', offset);
    const r = await fetch(u, { headers }); if (!r.ok) break;
    const j = await r.json(); (j.records||[]).forEach(rec => cur.push(rec.fields||{}));
    offset = j.offset;
  } while(offset);

  const current = {};
  cur.forEach(f => {
    if (f.AdminHold) return;
    const d = (f.Driver||'').toString().trim();
    const n = Number(f.Items||0);
    if (d && Number.isFinite(n)) current[d] = (current[d] || 0) + n;
  });

  return { foundAny, caps, current };
}

// Insert this before creating the Stripe session:
const { foundAny, caps, current } = await getDriverCapsAndLoad(deliveryDate, timeWindow);

// No driver caps defined => block
if (!foundAny) {
  return res.status(409).json({ error: 'driver_full' });
}

// Ensure at least one driver can fit qtyNeeded
const canFit = Object.entries(caps).some(([d, cap]) => {
  const used = Number(current[d] || 0);
  return (cap - used) >= qtyNeeded;
});
if (!canFit) {
  return res.status(409).json({ error: 'driver_full' });
}
