// api/drivers-capacity-set.js
// Upserts per-driver capacity by date+window into Airtable "DriverCaps".
// Auth: Authorization: Bearer <ADMIN_API_TOKEN> (also supports x-admin-token and ?token=)
// Body: { date: 'YYYY-MM-DD', caps: [{ driver:'Sean', window:'6:00–7:00 AM', capacity:5 }, ... ], clearMissing?: true }

function withCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
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
async function readJson(req){
  if (req.body && typeof req.body === 'object') return req.body;
  let body = ''; await new Promise(r=>{ req.on('data',c=>body+=c); req.on('end',r); });
  try { return JSON.parse(body||'{}'); } catch { return {}; }
}
const chunk = (arr, n=10) => {
  const out=[]; for (let i=0;i<arr.length;i+=n) out.push(arr.slice(i,i+n)); return out;
};
const normDash = s => String(s||'').replace(/–|—/g,'-').trim(); // normalize dashes

export default async function handler(req, res) {
  if (withCors(req, res)) return;
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST,OPTIONS');
      return res.status(405).json({ ok:false, error: 'method_not_allowed' });
    }

    // auth
    const token = getAdminToken(req);
    if (!process.env.ADMIN_API_TOKEN || token !== process.env.ADMIN_API_TOKEN) {
      return res.status(401).json({ ok:false, error:'unauthorized' });
    }

    const key  = process.env.AIRTABLE_API_KEY ?? '';
    const base = process.env.AIRTABLE_BASE_ID ?? '';
    const table = process.env.AIRTABLE_TABLE_DRIVER_CAPS || 'DriverCaps';
    if (!key || !base) {
      // allow UI to continue without Airtable connected
      return res.status(200).json({ ok:true, skipped:true, reason:'airtable_not_configured' });
    }

    const body = await readJson(req);
    const date = String(body.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ ok:false, error:'invalid_date' });
    }

    const clearMissing = !!body.clearMissing;
    const listIn = Array.isArray(body.caps) ? body.caps : [];
    if (!listIn.length) return res.status(400).json({ ok:false, error:'empty_caps' });

    // Normalize inputs
    const caps = listIn.map(r => ({
      driver: normDash(r.driver),
      window: normDash(r.window),
      capacity: Math.max(0, Number(r.capacity || 0))
    })).filter(r => r.driver && r.window);

    if (!caps.length) return res.status(400).json({ ok:false, error:'no_valid_rows' });

    const apiBase = `https://api.airtable.com/v0/${base}/${encodeURIComponent(table)}`;
    const headers = { Authorization: 'Bearer ' + key, 'Content-Type':'application/json' };

    // Load existing rows for that date (we'll map by driver+window)
    const existing = {};
    let offset;
    do {
      const u = new URL(apiBase);
      u.searchParams.set('filterByFormula', `AND({Date}='${date}')`);
      u.searchParams.set('pageSize','100');
      if (offset) u.searchParams.set('offset', offset);
      const r = await fetch(u.toString(), { headers: { Authorization:'Bearer ' + key } });
      if (!r.ok) break;
      const j = await r.json();
      for (const rec of (j.records || [])) {
        const f = rec.fields || {};
        const k = `${normDash(f.Driver)}|${normDash(f.Window)}`;
        existing[k] = { id: rec.id, capacity: Number(f.Capacity||0) };
      }
      offset = j.offset;
    } while (offset);

    // Prepare creates/updates
    const toCreate = [];
    const toUpdate = [];
    const seenKeys = new Set();

    for (const r of caps) {
      const k = `${r.driver}|${r.window}`;
      seenKeys.add(k);
      const found = existing[k];
      if (found) {
        toUpdate.push({ id: found.id, fields: { Date: date, Window: r.window, Driver: r.driver, Capacity: r.capacity } });
      } else {
        toCreate.push({ fields: { Date: date, Window: r.window, Driver: r.driver, Capacity: r.capacity } });
      }
    }

    // Optionally delete records that exist in Airtable for this date but are not included in the payload
    let deleted = [];
    if (clearMissing) {
      const toDeleteIds = Object.entries(existing)
        .filter(([k]) => !seenKeys.has(k))
        .map(([,v]) => v.id);
      for (const batch of chunk(toDeleteIds, 10)) {
        if (!batch.length) continue;
        const url = new URL(apiBase);
        batch.forEach(id => url.searchParams.append('records[]', id));
        const r = await fetch(url.toString(), { method:'DELETE', headers: { Authorization:'Bearer ' + key } });
        if (r.ok) deleted = deleted.concat(batch);
      }
    }

    // Batch create/update (Airtable limit 10 per request)
    let created = [], updated = [];

    for (const batch of chunk(toCreate, 10)) {
      const r = await fetch(apiBase, { method:'POST', headers, body: JSON.stringify({ records: batch }) });
      if (r.ok) {
        const j = await r.json();
        created = created.concat((j.records||[]).map(x => ({ id:x.id, ...x.fields })));
      } else {
        console.error('DriverCaps create failed:', await r.text().catch(()=>'')); // continue batching
      }
    }
    for (const batch of chunk(toUpdate, 10)) {
      const r = await fetch(apiBase, { method:'PATCH', headers, body: JSON.stringify({ records: batch }) });
      if (r.ok) {
        const j = await r.json();
        updated = updated.concat((j.records||[]).map(x => ({ id:x.id, ...x.fields })));
      } else {
        console.error('DriverCaps update failed:', await r.text().catch(()=>'')); // continue batching
      }
    }

    return res.status(200).json({
      ok:true,
      date,
      totals: { created: created.length, updated: updated.length, deleted: deleted.length },
      created,
      updated,
      deleted
    });
  } catch (err) {
    console.error('drivers-capacity-set error', err);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
}
