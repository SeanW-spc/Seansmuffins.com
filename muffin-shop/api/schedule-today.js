// api/schedule-today.js
const twilio = require('twilio');

// Helpers
function parseWindowStart(windowStr = '') {
  // Finds first time like "7:30 AM" or "7 AM" and returns minutes since midnight
  const m = windowStr.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i);
  if (!m) return 9 * 60; // fallback 9:00 AM
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3].toUpperCase();
  if (ampm === 'PM' && h !== 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return h * 60 + min;
}
function formatTime(minutes) {
  let h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  if (h === 0) h = 12;
  if (h > 12) h -= 12;
  return `${h}:${String(m).padStart(2, '0')} ${ampm}`;
}
function todayISO(tz = 'America/New_York') {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
  });
  const [y, m, d] = fmt.format(now).split('-');
  return `${y}-${m}-${d}`;
}

module.exports = async (req, res) => {
  try {
    const {
      AIRTABLE_API_KEY,
      AIRTABLE_BASE_ID,
      AIRTABLE_TABLE_NAME = 'Orders',
      TWILIO_ACCOUNT_SID,
      TWILIO_AUTH_TOKEN,
      TWILIO_FROM_NUMBER
    } = process.env;

    if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
      return res.status(500).json({ error: 'Missing Airtable env vars' });
    }

    // Parse query params
    const { searchParams } = new URL(req.url, `http://${req.headers.host}`);
    const date = searchParams.get('date') || todayISO();    // YYYY-MM-DD
    const stopMinutes = Number(searchParams.get('stop') || 12); // minutes per stop

    const tableUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}`;

    // 1) List all unassigned orders for the date
    const filter = `AND({delivery_date}='${date}', {status}='unassigned')`;
    const headers = { Authorization: `Bearer ${AIRTABLE_API_KEY}` };

    let records = [];
    let offset;
    do {
      const params = new URLSearchParams({ filterByFormula: filter, pageSize: '100' });
      if (offset) params.append('offset', offset);
      const r = await fetch(`${tableUrl}?${params}`, { headers });
      const j = await r.json();
      if (!r.ok) throw new Error(`Airtable list failed: ${r.status} ${JSON.stringify(j)}`);
      records.push(...(j.records || []));
      offset = j.offset;
    } while (offset);

    if (records.length === 0) {
      return res.status(200).json({ message: `No unassigned orders for ${date}.` });
    }

    // 2) Sort by preferred window start
    const sorted = records
      .map(r => ({ r, startMin: parseWindowStart(r.fields?.preferred_window || '') }))
      .sort((a, b) => a.startMin - b.startMin);

    // 3) Assign ETAs
    const earliest = Math.min(...sorted.map(s => s.startMin), 8 * 60); // earliest request or 8:00 AM
    let current = earliest;

    const updates = sorted.map((s, idx) => {
      const eta = formatTime(current);
      current += stopMinutes;
      return {
        id: s.r.id,
        fields: {
          status: 'scheduled',
          route_position: idx + 1,
          delivery_time: eta
        }
      };
    });

    // 4) Patch updates in batches of 10
    for (let i = 0; i < updates.length; i += 10) {
      const batch = updates.slice(i, i + 10);
      const r = await fetch(tableUrl, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ records: batch })
      });
      const txt = await r.text();
      if (!r.ok) throw new Error(`Airtable update failed: ${r.status} ${txt}`);
    }

    // 5) (Optional) Send SMS via Twilio
    let sms_sent = 0;
    if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM_NUMBER) {
      const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
      for (const u of updates) {
        const rec = records.find(x => x.id === u.id);
        const phone = rec?.fields?.phone;
        if (!phone) continue;
        const first = (rec?.fields?.customer_name || '').split(' ')[0] || 'there';
        const msg = `Hi ${first}, Sean’s Muffins here! Your delivery is scheduled for ~${u.fields.delivery_time} on ${date}. Reply STOP to opt out.`;
        try {
          await client.messages.create({ to: phone, from: TWILIO_FROM_NUMBER, body: msg });
          sms_sent++;
        } catch (e) {
          console.warn('SMS failed', phone, e.message);
        }
      }
    } else {
      console.warn('Twilio env vars missing — skipped SMS.');
    }

    return res.status(200).json({
      date,
      scheduled: updates.length,
      sms_sent
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
};
