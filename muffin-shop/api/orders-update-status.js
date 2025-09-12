// api/orders-update-status.js
// Update a single order's status / delivery_time / route_position + CORS + Bearer auth.
// Targets by Airtable record {id} OR by Stripe {sessionId}. Also mirrors status to Slots(SessionId).

/* ---------------- CORS + Auth helpers ---------------- */
function withCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*'); // lock to your dev origin(s) if you prefer
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

/* ---------------- Main handler ---------------- */
export default async function handler(req, res) {
  if (withCors(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST,OPTIONS');
    return res.status(405).json({ ok:false, error:'method_not_allowed' });
  }

  try {
    const token = getAdminToken(req);
    if (!process.env.ADMIN_API_TOKEN || token !== process.env.ADMIN_API_TOKEN) {
      return res.status(401).json({ ok:false, error:'unauthorized' });
    }

    const body = await readJson(req);
    const { id, sessionId, status, delivery_time, route_position } = body || {};

    if (!id && !sessionId) {
      return res.status(400).json({ ok:false, error:'missing_target', message:'Provide id or sessionId' });
    }

    if (!process.env.AIRTABLE_API_KEY || !process.env.AIRTABLE_BASE_ID) {
      return res.status(500).json({ ok:false, error:'airtable_config' });
    }

    // Normalize status (optional)
    let statusNorm = undefined;
    if (typeof status === 'string' && status.trim()) {
      const s = status.trim().toLowerCase();
      if (!['confirmed','canceled','pending'].includes(s)) {
        return res.status(400).json({ ok:false, error:'invalid_status' });
      }
      statusNorm = s;
    }

    const baseId     = process.env.AIRTABLE_BASE_ID;
    const ordersTbl  = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME  || 'Orders'); // lowercase fields
    const slotsTbl   = encodeURIComponent(process.env.AIRTABLE_TABLE_SLOTS || 'Slots');  // Title-case fields
    const apiBase    = `https://api.airtable.com/v0/${baseId}`;
    const headers    = { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' };

    // Determine the order record ID and the (Stripe) session id
    let recordId = id || null;
    let sessId   = sessionId || null;

    if (!recordId && sessId) {
      const rec = await findOrderBySession(apiBase, ordersTbl, sessId);
      if (!rec) return res.status(404).json({ ok:false, error:'order_not_found' });
      recordId = rec.id;
    }

    if (recordId && !sessId) {
      const rec = await getOrderById(apiBase, ordersTbl, recordId);
      if (!rec) return res.status(404).json({ ok:false, error:'order_not_found' });
      sessId = rec.fields?.stripe_session_id || null;
    }

    // Build fields to patch on Orders (only include provided fields)
    const fields = {};
    if (statusNorm)                      fields.status          = statusNorm;
    if (typeof delivery_time === 'string') fields.delivery_time   = delivery_time;
    if (typeof route_position !== 'undefined') fields.route_position = route_position;

    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ ok:false, error:'nothing_to_update' });
    }

    // Patch Orders
    const updateOrdersUrl = `${apiBase}/${ordersTbl}`;
    const r = await fetch(updateOrdersUrl, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ records: [{ id: recordId, fields }] })
    });
    if (!r.ok) {
      const txt = await r.text().catch(()=> '');
      return res.status(500).json({ ok:false, error:'airtable_update_failed', detail: txt });
    }
    const j = await r.json();
    const updatedId = j.records?.[0]?.id || recordId;

    // If status was provided and we have a session id, mirror to Slots(SessionId)
    let slotsUpdated = 0;
    if (statusNorm && sessId) {
      slotsUpdated = await updateSlotsBySession(apiBase, slotsTbl, headers, sessId, statusNorm);
    }

    return res.status(200).json({ ok:true, updated: updatedId, slotsUpdated });
  } catch (err) {
    console.error('orders-update-status error', err);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
}

/* ---------------- Helpers ---------------- */

// Robust body reader for Vercel/Node
async function readJson(req) {
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

// GET a single Orders record by Airtable record id
async function getOrderById(apiBase, table, recordId) {
  const r = await fetch(`${apiBase}/${table}/${recordId}`, {
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` }
  });
  if (!r.ok) return null;
  return await r.json();
}

// Find an Orders record by stripe_session_id
async function findOrderBySession(apiBase, table, sessionId) {
  const u = new URL(`${apiBase}/${table}`);
  // Field is lowercase in your Orders table
  u.searchParams.set('filterByFormula', `{stripe_session_id}='${sessionId}'`);
  u.searchParams.set('pageSize', '1');
  const r = await fetch(u.toString(), {
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` }
  });
  if (!r.ok) return null;
  const j = await r.json();
  return (j.records || [])[0] || null;
}

// Update all Slots records with SessionId == sessionId to the new status
async function updateSlotsBySession(apiBase, slotsTbl, headers, sessionId, statusNorm) {
  // First list matching slots
  const u = new URL(`${apiBase}/${slotsTbl}`);
  // Note: field names in Slots are Title-case per your schema
  u.searchParams.set('filterByFormula', `{SessionId}='${sessionId}'`);
  u.searchParams.set('pageSize', '100');

  let offset = null, ids = [];
  do {
    if (offset) u.searchParams.set('offset', offset);
    const r = await fetch(u.toString(), { headers: { Authorization: headers.Authorization } });
    if (!r.ok) break;
    const j = await r.json();
    ids.push(...(j.records || []).map(rec => rec.id));
    offset = j.offset;
  } while (offset);

  if (!ids.length) return 0;

  // Batch patch in chunks of 10 (Airtable limit for PATCH payload size)
  const nowIso = new Date().toISOString();
  let updated = 0;
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10);
    const r2 = await fetch(`${apiBase}/${slotsTbl}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        records: chunk.map(id => ({
          id,
          fields: { Status: statusNorm, Updated: nowIso }
        }))
      })
    });
    if (r2.ok) {
      const j2 = await r2.json();
      updated += (j2.records || []).length;
    }
  }
  return updated;
}
