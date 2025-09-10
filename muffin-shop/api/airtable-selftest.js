// api/airtable-selftest.js
// Simple read test against your Orders table.
// Visit: /api/airtable-selftest

export default async function handler(req, res) {
  try {
    const { AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_TABLE_NAME = 'Orders' } = process.env;
    if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
      return res.status(500).json({ ok: false, error: 'Missing env vars' });
    }
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}?maxRecords=1`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` } });
    const bodyText = await r.text();
    let body;
    try { body = JSON.parse(bodyText); } catch { body = bodyText; }
    return res.status(r.status).json({ ok: r.ok, status: r.status, body });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
