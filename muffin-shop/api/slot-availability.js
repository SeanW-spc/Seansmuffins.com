// api/slot-availability.js
// Returns which delivery windows are available for a given date, based on Airtable "Slots".

function hasAirtableConfig() {
  return Boolean(
    process.env.AIRTABLE_API_KEY &&
    process.env.AIRTABLE_BASE_ID &&
    process.env.AIRTABLE_TABLE_SLOTS
  );
}

function getWindows() {
  return ['6:00–7:00 AM', '7:00–8:00 AM', '8:00–9:00 AM'];
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
  }

  const date = String(req.query?.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'date (YYYY-MM-DD) required' });
  }
  const capacity = parseInt(process.env.SLOT_CAPACITY_DEFAULT || '12', 10);

  if (!hasAirtableConfig()) {
    // If Airtable not configured, consider all available
    return res.status(200).json({
      date, capacity,
      windows: getWindows().map(w => ({ window: w, remaining: capacity, available: true }))
    });
  }

  try {
    const table = encodeURIComponent(process.env.AIRTABLE_TABLE_SLOTS);
    const base  = process.env.AIRTABLE_BASE_ID;
    const url   = `https://api.airtable.com/v0/${base}/${table}`;

    async function countFor(win) {
      const f = `AND({Date}='${date}', {Window}='${win}', OR({Status}='confirmed', AND({Status}='pending', DATETIME_DIFF(NOW(), {Created}, 'minutes') < 60)))`;
      let offset = null, total = 0;
      do {
        const q = new URL(url);
        q.searchParams.set('pageSize', '100');
        q.searchParams.set('filterByFormula', f);
        if (offset) q.searchParams.set('offset', offset);

        const r = await fetch(q.toString(), {
          headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
        });
        if (!r.ok) throw new Error(`Airtable error ${r.status}`);
        const data = await r.json();
        total += (data.records || []).length;
        offset = data.offset;
      } while (offset);
      return total;
    }

    const windows = [];
    for (const w of getWindows()) {
      const c = await countFor(w);
      const remaining = Math.max(0, capacity - c);
      windows.push({ window: w, remaining, available: remaining > 0 });
    }

    res.status(200).json({ date, capacity, windows });
  } catch (err) {
    console.error('slot-availability error', err?.message);
    // Soft fail: if Airtable hiccups, don't block user; show all as available
    res.status(200).json({
      date, capacity,
      windows: getWindows().map(w => ({ window: w, remaining: capacity, available: true }))
    });
  }
}
