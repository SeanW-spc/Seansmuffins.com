module.exports = async (req, res) => {
  try {
    const { AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_TABLE_NAME = 'Orders' } = process.env;
    if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
      return res.status(500).json({ ok: false, error: 'Missing env vars' });
    }
    const r = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}?maxRecords=1`, {
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` }
    });
    const text = await r.text();
    return res.status(r.status).json({ ok: r.ok, status: r.status, body: safe(text) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
  function safe(s){ try { return JSON.parse(s); } catch { return s; } }
};
