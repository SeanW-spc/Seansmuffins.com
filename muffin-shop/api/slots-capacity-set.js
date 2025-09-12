// api/slots-capacity-set.js
// Upsert capacity override for a date/window in Airtable + CORS.
// Body: { date, window, capacity|null }   (null removes override)
// Auth: Authorization: Bearer <ADMIN_API_TOKEN>  (also supports x-admin-token and ?token=)

/* ---------------- CORS + Auth helpers ---------------- */
function withCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*'); // lock to specific origins if desired
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Token');
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  return false;
}
function getAdminToken(req) {
  const auth = (req.headers.authorization || '').trim();
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7);
  const hdr = (req.headers['x-admin-token'] || '').toString().trim();
  if (hdr) return hdr;
  const q = (req.query && req.query.token) ? String(req.query.token) : '';
  if (q) return q;
  try { if (req.body && typeof req.body === 'object' && req.body.token) return String(req.body.token); } catch {}
  return '';
}

/* ---------------- Windows helpers ---------------- */
function getWindows() {
  return ['6:00–7:00 AM', '7:00–8:00 AM', '8:00–9:00 AM'];
}
function normalizeWindow(win){
  return String(win || '').replace(/\s+—.*$/, '').trim();
}

/* ---------------- Main handler ---------------- */
export default async function handler(req, res) {
  if (withCors(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow','POST,OPTIONS');
    return res.status(405).json({ ok:false, error:'method_not_allowed' });
  }

  try {
    const token = getAdminToken(req);
    if (!process.env.ADMIN_API_TOKEN || token !== process.env.ADMIN_API_TOKEN) {
      return res.status(401).json({ ok:false, error:'unauthorized' });
    }
    if (!process.env.AIRTABLE_API_KEY || !process.env.AIRTABLE_BASE_ID) {
      return res.status(500).json({ ok:false, error:'airtable_config' });
    }

    const body = await readJson(req);
    const dateRaw = (body.date || '').toString().trim();
    const windowRaw = (body.window || '').toString();
    const capRaw = (body.capacity === null || body.capacity === undefined) ? null : Number(body.capacity);

    // Validate date
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) {
      return res.status(400).json({ ok:false, error:'invalid_date', message:'date must be YYYY-MM-DD' });
    }

    // Validate window
    const winNorm = normalizeWindow(windowRaw);
    if (!getWindows().includes(winNorm)) {
      return res.status(400).json({ ok:false, error:'invalid_window' });
    }

    // Validate capacity (allow null to remove override)
    if (capRaw !== null) {
      if (!Number.isFinite(capRaw) || capRaw < 0) {
        return res.status(400).json({ ok:false, error:'invalid_capacity' });
      }
    }

    const base = process.env.AIRTABLE_BASE_ID;
    const table = encodeURIComponent(process.env.AIRTABLE_TABLE_SLOT_CAPS || 'SlotCaps');
    const url = `https://api.airtable.com/v0/${base}/${table}`;
    const headers = { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' };

    // find existing override
    const finder = new URL(url);
    finder.searchParams.set('filterByFormula', `AND({Date}='${dateRaw}', {Window}='${winNorm}')`);
    const r0 = await fetch(finder.toString(), { headers: { Authorization: headers.Authorization } });
    if (!r0.ok) return res.status(500).json({ ok:false, error:'airtable_list_failed', detail: await r0.text().catch(()=> '') });
    const j0 = await r0.json();
    const rec = (j0.records || [])[0];

    if (capRaw === null) {
      // remove override (delete record if exists)
      if (!rec) return res.status(200).json({ ok:true, removed:false });
      const del = await fetch(`${url}?records[]=${rec.id}`, { method: 'DELETE', headers: { Authorization: headers.Authorization } });
      if (!del.ok) return res.status(500).json({ ok:false, error:'airtable_delete_failed', detail: await del.text().catch(()=> '') });
      return res.status(200).json({ ok:true, removed:true });
    }

    // upsert capacity
    if (rec) {
      const upd = await fetch(url, {
        method:'PATCH', headers,
        body: JSON.stringify({ records: [{ id: rec.id, fields: { Capacity: capRaw } }] })
      });
      if (!upd.ok) return res.status(500).json({ ok:false, error:'airtable_update_failed', detail: await upd.text().catch(()=> '') });
      return res.status(200).json({ ok:true, updated:true });
    } else {
      const crt = await fetch(url, {
        method:'POST', headers,
        body: JSON.stringify({ records: [{ fields: { Date: dateRaw, Window: winNorm, Capacity: capRaw } }] })
      });
      if (!crt.ok) return res.status(500).json({ ok:false, error:'airtable_create_failed', detail: await crt.text().catch(()=> '') });
      return res.status(200).json({ ok:true, created:true });
    }
  } catch (e) {
    console.error('slots-capacity-set error', e);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
}

/* ---------------- readJson ---------------- */
async function readJson(req){
  if (req.body) {
    if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
    if (typeof req.body === 'object') return req.body;
  }
  let body = '';
  await new Promise((resolve) => {
    req.on('data', (c) => { body += c; });
    req.on('end', resolve);
  });
  try { return JSON.parse(body || '{}'); } catch { return {}; }
}
