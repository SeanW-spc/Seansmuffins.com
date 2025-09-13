// api/create-checkout-session.js
// Checks capacity (incl. DriverCaps sum override), optionally enforces per-driver caps,
// holds a slot, then creates a Stripe Checkout Session.

import Stripe from 'stripe';
const stripeKey = process.env.STRIPE_SECRET_KEY ?? '';
const stripe = new Stripe(stripeKey, { apiVersion: '2024-06-20' });

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.seansmuffins.com';
const FRESH_MINUTES = Number(process.env.PENDING_FRESH_MIN || 60);

// If true, continue to Stripe even if the Slots "pending" reservation fails outright
const SOFT_RES =
  process.env.SOFT_RESERVATIONS === '1' ||
  !process.env.AIRTABLE_API_KEY ||
  !process.env.AIRTABLE_BASE_ID;

// TEMPORARY safety: also fail-open when Airtable returns a schema/table error.
// Set FAIL_OPEN_ON_AIRTABLE_ERROR=0 to disable once Airtable is fully configured.
const FAIL_OPEN_ON_AIRTABLE_ERROR =
  (process.env.FAIL_OPEN_ON_AIRTABLE_ERROR ?? '1') !== '0';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'method_not_allowed' });
    }

    if (!stripeKey || !stripeKey.startsWith('sk_')) {
      return res.status(500).json({ error: 'stripe_config' });
    }

    // ---------- Body + field normalization ----------
    const body = (await readJson(req)) || {};
    const modeRaw = String(body.mode || 'payment').toLowerCase();

    // Accept BOTH camelCase and snake_case from client
    const items = body.items;
    const rawDeliveryDate =
      body.deliveryDate ?? body.delivery_date ?? body.delivery ?? '';
    const rawWindow =
      body.timeWindow ?? body.preferred_window ?? body.preferredWindow ?? '';

    const timeWindow = normalizeWindow(rawWindow);
    const deliveryDate = String(rawDeliveryDate || '');

    // ---------- Validation ----------
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'missing_fields' });
    }
    if (modeRaw === 'subscription') return res.status(403).json({ error: 'subscription_disabled' });
    if (modeRaw !== 'payment') return res.status(400).json({ error: 'invalid_mode' });

    for (const it of items) {
      if (!it || typeof it.price !== 'string' || !it.price) {
        // Align with client UI
        return res.status(400).json({ error: 'invalid_price' });
      }
    }

    if (!timeWindow || !getWindows().includes(timeWindow)) {
      return res.status(400).json({ error: 'invalid_window' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(deliveryDate)) {
      return res.status(400).json({ error: 'invalid_date' });
    }

    // ---------- Capacity check by total quantity (driver-aware) ----------
    const qtyNeeded = Array.isArray(items)
      ? items.reduce((n, it) => n + Number(it?.quantity || 1), 0)
      : 1;

    // Capacity = sum(DriverCaps) if any exist; else SlotCaps override; else default
    const cap = await resolveCapacity(deliveryDate, timeWindow);
    const cur = await countOccupied(deliveryDate, timeWindow); // includes AdminHold and fresh pending
    if (cur + qtyNeeded > cap) {
      const suggestions = await findAlternativeWindows(deliveryDate, timeWindow, qtyNeeded);
      return res.status(409).json({ error: 'window_full', suggestions });
    }

    // Per-driver enforcement & assignment (if DriverCaps exist)
    const pick = await pickDriver(deliveryDate, timeWindow, qtyNeeded);
    if (pick.enforced && !pick.driver) {
      const suggestions = await findAlternativeWindows(deliveryDate, timeWindow, qtyNeeded);
      return res.status(409).json({ error: 'driver_full', suggestions });
    }
    const chosenDriver = pick.driver || null;

    // ---------- Pending reservation in Slots (best effort) ----------
    let reservationId = '';
    try {
      reservationId = await createPendingReservation(
        deliveryDate,
        timeWindow,
        qtyNeeded,
        chosenDriver
      );
    } catch (err) {
      console.error('Slots pending create threw:', err);
    }
    if (!reservationId) {
      if (SOFT_RES || FAIL_OPEN_ON_AIRTABLE_ERROR) {
        reservationId = `noop_${Date.now().toString(36)}`;
        console.warn('Slots reservation failed; proceeding (soft/fail-open).');
      } else {
        return res.status(502).json({ error: 'slots_reservation_failed' });
      }
    }

    // ---------- Stripe Checkout Session ----------
    let session;
    try {
      session = await stripe.checkout.sessions.create({
        mode: modeRaw,
        line_items: items.map(i => ({ price: i.price, quantity: i.quantity || 1 })),
        allow_promotion_codes: true,
        success_url: `${SITE_URL}/thank-you.html?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${SITE_URL}/`,
        metadata: {
          deliveryDate,
          timeWindow,
          reservationId,
          driver: chosenDriver || '',
          order_notes: String(body.orderNotes || '').slice(0, 500)
        },
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
    return res.status(500).json({ error: 'server_error' });
  }
}

/* ------------ Helpers ------------ */

// Normalize "6:00-7:00 AM", "6:00 – 7:00 am", "6:00–7:00AM" → exactly a value from getWindows()
function normalizeWindow(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  s = s.replace(/\s*-\s*/g, '–').replace(/\s*–\s*/g, '–');        // use en-dash consistently
  s = s.replace(/\s*(am|pm)$/i, m => ' ' + m.toUpperCase());       // ensure " AM"/" PM"
  if (getWindows().includes(s)) return s;
  const tryAm = s.endsWith(' AM') ? s : `${s} AM`;
  const tryPm = s.endsWith(' PM') ? s : `${s} PM`;
  if (getWindows().includes(tryAm)) return tryAm;
  if (getWindows().includes(tryPm)) return tryPm;
  const start = s.split('–')[0];
  return getWindows().find(w => w.startsWith(start)) || '';
}

// Driver pick with remaining capacity for (date, window, qtyNeeded)
async function pickDriver(date, window, qtyNeeded) {
  const key = process.env.AIRTABLE_API_KEY, base = process.env.AIRTABLE_BASE_ID;
  if (!key || !base) return { driver: null, enforced: false };
  const driverCapsTable = process.env.AIRTABLE_TABLE_DRIVER_CAPS || 'DriverCaps';
  const slotsTable = process.env.AIRTABLE_TABLE_SLOTS || 'Slots';

  // 1) load per-driver caps
  const f = encodeURIComponent(`AND({Date}='${date}',{Window}='${window}')`);
  const url = `https://api.airtable.com/v0/${base}/${encodeURIComponent(driverCapsTable)}?filterByFormula=${f}&pageSize=100`;
  const capsRes = await fetch(url, { headers:{ Authorization:'Bearer ' + key } });
  if (!capsRes.ok) return { driver: null, enforced: false };
  const capsJson = await capsRes.json();
  const caps = {};
  for (const rec of (capsJson.records || [])){
    const d = String(rec.fields?.Driver || '').trim();
    const c = Number(rec.fields?.Capacity || 0);
    if (d) caps[d] = (Number.isFinite(c) ? c : 0);
  }
  const drivers = Object.keys(caps);
  if (!drivers.length) return { driver: null, enforced: false };

  // 2) load current usage per driver (exclude AdminHold, include fresh pending)
  const sinceIso = new Date(Date.now() - FRESH_MINUTES*60*1000).toISOString();
  const filter = [
    `{Date}='${date}'`,
    `{Window}='${window}'`,
    `OR({Status}='confirmed', AND({Status}='pending', IS_AFTER({Updated}, '${sinceIso}')))`,
    'NOT({AdminHold}=1)'
  ].join(',');
  const formula = `AND(${filter})`;
  let offset, usage = {};
  do{
    const u = new URL(`https://api.airtable.com/v0/${base}/${encodeURIComponent(slotsTable)}`);
    u.searchParams.set('filterByFormula', formula);
    u.searchParams.set('pageSize','100');
    if (offset) u.searchParams.set('offset', offset);
    const r = await fetch(u.toString(), { headers:{ Authorization:'Bearer ' + key } });
    if (!r.ok) break;
    const j = await r.json();
    for (const rec of (j.records || [])){
      const f = rec.fields || {};
      const n = Number(f.Items || 0); if (!Number.isFinite(n)) continue;
      const drv = String(f.Driver || '').trim() || '(unassigned)';
      usage[drv] = (usage[drv] || 0) + n;
    }
    offset = j.offset;
  } while (offset);

  // 3) choose driver with remaining >= qtyNeeded, smallest current load
  let best = null, bestLoad = Infinity;
  for (const d of drivers){
    const remain = (caps[d] || 0) - (usage[d] || 0);
    if (remain >= qtyNeeded && (usage[d]||0) < bestLoad){
      best = d; bestLoad = (usage[d]||0);
    }
  }
  return { driver: best, enforced: true };
}

// Body reader for Vercel/Node
async function readJson(req) {
  if (req.body) {
    if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
    if (typeof req.body === 'object') return req.body;
  }
  let body = '';
  await new Promise((resolve) => {
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', resolve);
  });
  try { return JSON.parse(body || '{}'); } catch { return {}; }
}

// Keep in sync with site & Airtable
function getWindows() {
  return ['6:00–7:00 AM', '7:00–8:00 AM', '8:00–9:00 AM'];
}

// Capacity = sum(DriverCaps) if any exist; else SlotCaps override; else default
async function resolveCapacity(date, win) {
  const defCap = Number(process.env.SLOT_CAPACITY_DEFAULT || 12);
  const base = process.env.AIRTABLE_BASE_ID;
  const key = process.env.AIRTABLE_API_KEY;
  if (!base || !key) return defCap;

  const slotTable   = encodeURIComponent(process.env.AIRTABLE_TABLE_SLOT_CAPS   || 'SlotCaps');
  const driverTable = encodeURIComponent(process.env.AIRTABLE_TABLE_DRIVER_CAPS || 'DriverCaps');

  // Slot override (optional)
  let slotCap = null;
  {
    const u = new URL(`https://api.airtable.com/v0/${base}/${slotTable}`);
    u.searchParams.set('filterByFormula', `AND({Date}='${date}', {Window}='${win}')`);
    u.searchParams.set('maxRecords','1');
    const r = await fetch(u.toString(), { headers: { Authorization: `Bearer ${key}` } });
    if (r.ok){
      const j = await r.json();
      const rec = (j.records || [])[0];
      if (rec && rec.fields?.Capacity != null){
        const n = Number(rec.fields.Capacity);
        slotCap = Number.isFinite(n) ? n : null;
      }
    }
  }

  // Per-driver caps (if present, they define total capacity)
  let perDriverSum = 0, foundDriverCaps = false;
  {
    const f = encodeURIComponent(`AND({Date}='${date}',{Window}='${win}')`);
    const u = `https://api.airtable.com/v0/${base}/${driverTable}?filterByFormula=${f}&pageSize=100`;
    const r = await fetch(u, { headers:{ Authorization: `Bearer ${key}` } });
    if (r.ok){
      const j = await r.json();
      for (const rec of (j.records || [])){
        const n = Number(rec.fields?.Capacity || 0);
        if (Number.isFinite(n)) { perDriverSum += n; foundDriverCaps = true; }
      }
    }
  }

  if (foundDriverCaps) return perDriverSum;
  if (slotCap != null)  return slotCap;
  return defCap;
}

// Confirmed + fresh pending + AdminHold
async function countOccupied(date, win) {
  const base = process.env.AIRTABLE_BASE_ID;
  const key = process.env.AIRTABLE_API_KEY;
  if (!base || !key) return 0;

  const table = encodeURIComponent(process.env.AIRTABLE_TABLE_SLOTS || 'Slots');
  const u = new URL(`https://api.airtable.com/v0/${base}/${table}`);
  const cutoff = new Date(Date.now() - FRESH_MINUTES*60*1000).toISOString();
  const formula = `AND({Date}='${date}', {Window}='${win}', OR({Status}='confirmed', AND({Status}='pending', IS_AFTER({Updated}, '${cutoff}')), {AdminHold}=1))`;
  u.searchParams.set('filterByFormula', formula);
  u.searchParams.set('pageSize', '100');

  let offset = null, count = 0;
  do {
    if (offset) u.searchParams.set('offset', offset);
    const r = await fetch(u.toString(), { headers: { Authorization: `Bearer ${key}` } });
    if (!r.ok) break;
    const j = await r.json();
    count += (j.records || []).reduce((s, rec) => s + Number(rec.fields?.Items || 1), 0);
    offset = j.offset;
  } while (offset);
  return count;
}

async function createPendingReservation(date, win, qty, driver = null) {
  const base = process.env.AIRTABLE_BASE_ID;
  const key = process.env.AIRTABLE_API_KEY;
  const table = encodeURIComponent(process.env.AIRTABLE_TABLE_SLOTS || 'Slots');

  if (!base || !key) return ''; // let SOFT_RES/FAIL_OPEN decide

  const url = `https://api.airtable.com/v0/${base}/${table}`;
  const reservationId = Math.random().toString(36).slice(2) + Date.now().toString(36);

  const fields = {
    Date: date,
    Window: win,
    Status: 'pending',
    Items: Number(qty) || 1,
    ReservationId: reservationId,
    Updated: new Date().toISOString()
  };
  if (driver) fields.Driver = driver;

  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      records: [{ fields }],
      typecast: true
    })
  });

  if (!r.ok) {
    const txt = await safeText(r);
    console.error('Slots pending create failed', txt);
    if (FAIL_OPEN_ON_AIRTABLE_ERROR) {
      return `noop_${Date.now().toString(36)}`;
    }
    return '';
  }
  return reservationId;
}

async function cancelReservation(reservationId) {
  if (!reservationId || reservationId.startsWith('noop_')) return;
  const base = process.env.AIRTABLE_BASE_ID;
  const key = process.env.AIRTABLE_API_KEY;
  if (!base || !key) return;
  const table = encodeURIComponent(process.env.AIRTABLE_TABLE_SLOTS || 'Slots');

  // Lookup by ReservationId
  const listUrl = new URL(`https://api.airtable.com/v0/${base}/${table}`);
  listUrl.searchParams.set('filterByFormula', `AND({ReservationId}='${reservationId}', {Status}='pending')`);
  const listRes = await fetch(listUrl.toString(), { headers: { Authorization: `Bearer ${key}` } });
  if (!listRes.ok) return;
  const data = await listRes.json();
  const rec = (data.records || [])[0];
  if (!rec?.id) return;

  // Patch to canceled
  await fetch(`https://api.airtable.com/v0/${base}/${table}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      records: [{ id: rec.id, fields: { Status: 'canceled', Updated: new Date().toISOString() } }]
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
    if (out.length >= 3) break;
  }
  return out;
}

async function safeText(r){
  try { return await r.text(); } catch { return ''; }
}
