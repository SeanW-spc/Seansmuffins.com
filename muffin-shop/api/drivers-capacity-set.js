// api/drivers-capacity-set.js
// Upserts per-driver capacity by date+window into Airtable "DriverCaps" table.
// Body: { date: 'YYYY-MM-DD', caps: [{ driver:'Sean', window:'6:00–7:00 AM', capacity:5 }, ... ] }

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'method_not_allowed' });
    }
    const key = process.env.AIRTABLE_API_KEY ?? '';
    const base = process.env.AIRTABLE_BASE_ID ?? '';
    const table = process.env.AIRTABLE_TABLE_DRIVER_CAPS || 'DriverCaps';
    if (!key || !base) {
      return res.status(200).json({ ok:true, skipped:true, reason:'airtable_not_configured' });
    }
    const { date, caps } = req.body || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
      return res.status(400).json({ error: 'invalid_date' });
    }
    const list = Array.isArray(caps) ? caps : [];
    if (!list.length) return res.status(400).json({ error: 'empty_caps' });

    async function findRecordId(date, window, driver) {
      const f = encodeURIComponent(`AND({Date}='${date}',{Window}='${window}',{Driver}='${driver}')`);
      const u = `https://api.airtable.com/v0/${base}/${encodeURIComponent(table)}?filterByFormula=${f}&maxRecords=1`;
      const r = await fetch(u, { headers: { Authorization: 'Bearer ' + key } });
      if (!r.ok) return null;
      const j = await r.json();
      const rec = (j.records || [])[0];
      return rec ? rec.id : null;
    }

    const created = [], updated = [];
    for (const row of list) {
      const window = String(row.window || '');
      const driver = String(row.driver || '');
      const capacity = Math.max(0, Number(row.capacity || 0));
      if (!window || !driver) continue;

      const recId = await findRecordId(date, window, driver);
      if (recId) {
        const u = `https://api.airtable.com/v0/${base}/${encodeURIComponent(table)}/${recId}`;
        const r = await fetch(u, {
          method: 'PATCH',
          headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: { Date: date, Window: window, Driver: driver, Capacity: capacity } })
        });
        if (r.ok) updated.push({ driver, window, capacity });
      } else {
        const u = `https://api.airtable.com/v0/${base}/${encodeURIComponent(table)}`;
        const r = await fetch(u, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: { Date: date, Window: window, Driver: driver, Capacity: capacity } })
        });
        if (r.ok) created.push({ driver, window, capacity });
      }
    }

    return res.status(200).json({ ok:true, date, created, updated });
  } catch (err) {
    console.error('drivers-capacity-set error', err);
    return res.status(500).json({ error:'server_error' });
  }
}
