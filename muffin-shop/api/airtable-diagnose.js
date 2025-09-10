// api/airtable-diagnose.js
// Browser-friendly diagnostics to verify Airtable env/config and write test records.
// Usage:
//   GET /api/airtable-diagnose
//   GET /api/airtable-diagnose?write=orders
//   GET /api/airtable-diagnose?write=slots

export default async function handler(req, res) {
  try {
    const cfg = {
      hasKey: !!process.env.AIRTABLE_API_KEY,
      hasBase: !!process.env.AIRTABLE_BASE_ID,
      tableOrders: process.env.AIRTABLE_TABLE_NAME || 'Orders',
      tableSlots: process.env.AIRTABLE_TABLE_SLOTS || 'Slots',
      baseIdMasked: (process.env.AIRTABLE_BASE_ID || '').replace(/^(.{3}).+(.{3})$/, '$1…$2')
    };
    if (!cfg.hasKey || !cfg.hasBase) {
      return res.status(500).json({ ok: false, step: 'env', cfg, msg: 'Missing AIRTABLE_API_KEY or AIRTABLE_BASE_ID' });
    }

    const base = process.env.AIRTABLE_BASE_ID;
    const ORD = encodeURIComponent(cfg.tableOrders);
    const SLOTS = encodeURIComponent(cfg.tableSlots);

    // Simple read checks (pageSize=1)
    const readOrders = await airtableGet(`https://api.airtable.com/v0/${base}/${ORD}?pageSize=1`);
    const readSlots  = await airtableGet(`https://api.airtable.com/v0/${base}/${SLOTS}?pageSize=1`);

    const action = (req.query.write || '').toString();
    if (action === 'orders') {
      const now = new Date();
      const testFields = {
        delivery_date: now.toISOString().slice(0,10),
        preferred_window: '7:00–8:00 AM',
        status: 'unassigned',
        customer_name: 'Diag Test',
        email: 'diag@example.com',
        items: 'Test item x1',
        stripe_session_id: 'diag_' + Date.now(),
        created: now.toISOString(),
        notes: 'diagnostic write'
      };
      const writeOrders = await airtablePost(`https://api.airtable.com/v0/${base}/${ORD}`, { records: [{ fields: testFields }] });
      return res.status(200).json({ ok: true, cfg, readOrders, readSlots, writeOrders });
    }

    if (action === 'slots') {
      const now = new Date();
      const dateStr = now.toISOString().slice(0,10);
      const testSlot = {
        ReservationId: 'diag_' + Math.random().toString(36).slice(2),
        Date: dateStr,
        Window: '7:00–8:00 AM',
        Status: 'pending',
        Items: 1,
        Created: now.toISOString()
      };
      const writeSlots = await airtablePost(`https://api.airtable.com/v0/${base}/${SLOTS}`, { records: [{ fields: testSlot }] });
      return res.status(200).json({ ok: true, cfg, readOrders, readSlots, writeSlots });
    }

    return res.status(200).json({ ok: true, cfg, readOrders, readSlots, hint: 'Add ?write=orders or ?write=slots to create a test row.' });
  } catch (err) {
    const msg = String(err?.message || err);
    return res.status(500).json({ ok: false, error: msg });
  }
}

async function airtableGet(url) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` } });
  return { status: r.status, ok: r.ok, body: await safeJson(r) };
}
async function airtablePost(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, ok: r.ok, body: await safeJson(r) };
}
async function safeJson(r) {
  try { return await r.json(); } catch { return await r.text(); }
}
