// api/create-checkout-session.js
// Checks capacity (incl. SlotCaps override), holds a slot, then creates a Stripe Checkout Session.
// Launch setting: subscriptions disabled. Returns clear JSON errors to the client.

import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '', { apiVersion: '2024-06-20' });

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'method_not_allowed' });
    }

    const { mode = 'payment', items, deliveryDate, timeWindow, orderNotes } = (await readJson(req)) || {};

    // ---- Basic validation ----
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'missing_fields' });

    // Disable subscriptions for launch
    const m = String(mode || 'payment').toLowerCase();
    if (m === 'subscription') return res.status(403).json({ error: 'subscription_disabled' });
    if (m !== 'payment') return res.status(400).json({ error: 'invalid_mode' });

    // Validate item shapes
    for (const it of items) {
      if (!it || typeof it.price !== 'string' || !it.price) {
        return res.status(400).json({ error: 'missing_price' });
      }
    }

    // Validate window + date early to avoid 500s
    if (!getWindows().includes(timeWindow)) {
      return res.status(400).json({ error: 'invalid_window' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(deliveryDate || ''))) {
      return res.status(400).json({ error: 'invalid_date' });
    }

    // ---- Capacity check by total quantity ----
    const totalQty = items.reduce((s, i) => s + (Number(i.quantity) || 0), 0) || 1;
    const capacity = await resolveCapacity(deliveryDate, timeWindow);
    const current = await countOccupied(deliveryDate, timeWindow);

    if (current + totalQty > capacity) {
      const suggestions = await findAlternativeWindows(deliveryDate, timeWindow, totalQty);
      return res.status(409).json({ error: 'window_full', capacity, current, suggestions });
    }

    // ---- Create pending reservation in Slots (expires after 60 minutes) ----
    const reservationId = await createPendingReservation(deliveryDate, timeWindow, totalQty);
    if (!reservationId) {
      // Best-effort error: if Airtable is misconfigured, signal a server issue
      return res.status(502).json({ error: 'slots_reservation_failed' });
    }

    // ---- Stripe Checkout Session ----
    const successUrlBase = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.seansmuffins.com';

    let session;
    try {
      session = await stripe.checkout.sessions.create({
        mode: m, // 'payment' only (subs disabled)
        line_items: items.map(i => ({ price: i.price, quantity: i.quantity || 1 })),
        allow_promotion_codes: true,
        success_url: `${successUrlBase}/thank-you.html?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${successUrlBase}/`,
        metadata: {
          deliveryDate,
          timeWindow,
          reservationId,
          order_notes: String(orderNotes || '').slice(0, 500)
        },
        // Optional field on the Stripe page
        custom_fields: [
          {
            key: 'order_notes',
            label: { type: 'custom', custom: 'Delivery notes / allergies (optional)' },
            type: 'text',
            optional: true
          }
        ]
      });
    } catch (err) {
      // Try to free the hold if Stripe failed
      try { await cancelReservation(reservationId); } catch {}
      const msg = String(err?.message || '').toLowerCase();
      if (msg.includes('no such price')) return res.status(400).json({ error: 'invalid_price' });
      if (msg.includes('test mode') && msg.includes('live')) return res.status(500).json({ error: 'stripe_key_mismatch' });
      console.error('Stripe create session failed:', err);
      return res.status(502).json({ error: 'stripe_error' });
    }

    return res.status(200).json({ id: session.id, url: session.url });
  } catch (e) {
    console.error('create-checkout-session error', e);
    if (String(e?.message || '').includes('recurring') && String(e?.message || '').includes('mode')) {
      return res.status(400).json({ error: 'subscription_not_allowed' });
    }
    return res.status(500).json({ error: 'server_error' });
  }
}

/* ------------ Helpers ------------ */

// Robust body reader for Vercel Node (no Next.js req.json())
async function readJson(req) {
  if (req.body) {
    if (typeof req.body === 'string') {
      try { return JSON.parse(req.body); } catch { return {}; }
    }
    if (typeof req.body === 'object') return req.body;
  }
  let body = '';
  await new Promise((resolve) => {
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', resolve);
  });
  try { return JSON.parse(body || '{}'); } catch { return {}; }
}

// Delivery windows (keep in sync with site + Airtable options)
function getWindows() {
  return ['6:00–7:00 AM', '7:00–8:00 AM', '8:00–9:00 AM'];
}

async function resolveCapacity(date, win) {
  const defCap = Number(process.env.SLOT_CAPACITY_DEFAULT || 12);
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_TABLE_SLOT_CAPS || 'SlotCaps');
  if (!base || !process.env.AIRTABLE_API_KEY) return defCap;

  const url = `https://api.airtable.com/v0/${base}/${table}`;
  const u = new URL(url);
  u.searchParams.set('filterByFormula', `AND({Date}='${date}', {Window}='${win}')`);
  const r = await fetch(u.toString(), { headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` } });
  if (!r.ok) return defCap;
  const j = await r.json();
  const rec = (j.records || [])[0];
  if (!rec || rec.fields?.Capacity == null) return defCap;
  const cap = Number(rec.fields.Capacity);
  return Number.isFinite(cap) ? cap : defCap;
}

async function countOccupied(date, win) {
  const base = process.env.AIRTABLE_BASE_ID;
  const apiKey = process.env.AIRTABLE_API_KEY;
  if (!base || !apiKey) return 0; // No Airtable: treat as empty (soft-fail)
  const table = encodeURIComponent(process.env.AIRTABLE_TABLE_SLOTS || 'Slots');
  const url = `https://api.airtable.com/v0/${base}/${table}`;
  const u = new URL(url);
  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 60 min holds still count
  const formula = `AND({Date}='${date}', {Window}='${win}', OR({Status}='confirmed', AND({Status}='pending', IS_AFTER({Updated}, '${cutoff}'))))`;
  u.searchParams.set('filterByFormula', formula);
  u.searchParams.set('pageSize', '100');

  let offset = null, count = 0;
  do {
    if (offset) u.searchParams.set('offset', offset);
    const r = await fetch(u.toString(), { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!r.ok) break;
    const j = await r.json();
    count += (j.records || []).reduce((s, rec) => s + Number(rec.fields?.Items || 1), 0);
    offset = j.offset;
  } while (offset);
  return count;
}

async function createPendingReservation(date, win, qty) {
  const base = process.env.AIRTABLE_BASE_ID;
  const apiKey = process.env.AIRTABLE_API_KEY;
  const table = encodeURIComponent(process.env.AIRTABLE_TABLE_SLOTS || 'Slots');

  // Gracefully no-op if Airtable isn’t configured yet (don’t block checkout)
  if (!base || !apiKey) return `noop_${Date.now().toString(36)}`;

  const url = `https://api.airtable.com/v0/${base}/${table}`;
  const reservationId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      records: [{
        fields: {
          Date: date,
          Window: win,
          Status: 'pending',
          Items: Number(qty) || 1,
          ReservationId: reservationId,
          Updated: new Date().toISOString()
        }
      }]
    })
  });
  if (!r.ok) {
    console.error('Slots pending create failed', await r.text().catch(() => ''));
    return '';
  }
  return reservationId;
}

async function cancelReservation(reservationId) {
  if (!reservationId || reservationId.startsWith('noop_')) return; // local/no-op hold
  const base = process.env.AIRTABLE_BASE_ID;
  const apiKey = process.env.AIRTABLE_API_KEY;
  if (!base || !apiKey) return;
  const table = encodeURIComponent(process.env.AIRTABLE_TABLE_SLOTS || 'Slots');

  // Look up the record by ReservationId
  const listUrl = new URL(`https://api.airtable.com/v0/${base}/${table}`);
  listUrl.searchParams.set('filterByFormula', `AND({ReservationId}='${reservationId}', {Status}='pending')`);
  const listRes = await fetch(listUrl.toString(), { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!listRes.ok) return;
  const data = await listRes.json();
  const rec = (data.records || [])[0];
  if (!rec?.id) return;

  // Patch to canceled
  const patchUrl = `https://api.airtable.com/v0/${base}/${table}`;
  await fetch(patchUrl, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      records: [{
        id: rec.id,
        fields: { Status: 'canceled', Updated: new Date().toISOString() }
      }]
    })
  }).catch(()=>{});
}

async function findAlternativeWindows(date, currentWin, qtyNeeded) {
  const wins = getWindows().filter(w => w !== currentWin);
  const out = [];
  for (const w of wins) {
    const cap = await resolveCapacity(date, w);
    const cur = await countOccupied(date, w);
    if (cur + (Number(qtyNeeded) || 1) <= cap) out.push(w);
    if (out.length >= 3) break; // limit suggestions
  }
  return out;
}
