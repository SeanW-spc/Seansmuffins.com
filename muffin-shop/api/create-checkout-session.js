// api/create-checkout-session.js
// Driver-only capacity enforcement:
// - Capacity = sum of DriverCaps for (date, window). If none exist => block.
// - Blocks when no driver can fit qtyNeeded.
// - Still counts AdminHold + fresh pending in total occupancy.
// - Picks least-loaded driver with room; stores on pending Slot + Stripe metadata.

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
const FAIL_OPEN_ON_AIRTABLE_ERROR =
  (process.env.FAIL_OPEN_ON_AIRTABLE_ERROR ?? '1') !== '0';

/* ------------ Dash helpers & Airtable paging ------------ */
const dashVariants = (win) => {
  const en = String(win || '').replace(/-/g, '–');
  const hy = en.replace(/–|—/g, '-');
  return [en, hy];
};
async function readAll(urlStr, headers){
  const base = new URL(urlStr);
  const out = []; let offset;
  do{
    const u = new URL(base);
    if (offset) u.searchParams.set('offset', offset);
    const r = await fetch(u.toString(), { headers });
    if (!r.ok) break;
    const j = await r.json();
    (j.records || []).forEach(rec => out.push(rec.fields || {}));
    offset = j.offset;
  } while (offset);
  return out;
}

/* ------------ HTTP handler ------------ */
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

    const items = body.items;
    const rawDeliveryDate = body.deliveryDate ?? body.delivery_date ?? body.delivery ?? '';
    const rawWindow = body.timeWindow ?? body.preferred_window ?? body.preferredWindow ?? '';

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
        return res.status(400).json({ error: 'invalid_price' });
      }
    }

    if (!timeWindow || !getWindows().includes(timeWindow)) {
      return res.status(400).json({ error: 'invalid_window' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(deliveryDate)) {
      return res.status(400).json({ error: 'invalid_date' });
    }

    // ---------- Capacity check (driver-only) ----------
    const qtyNeeded = Array.isArray(items)
      ? items.reduce((n, it) => n + Number(it?.quantity || 1), 0)
      : 1;

    const { foundAny, capsByDriver } = await loadDriverCaps(deliveryDate, timeWindow);
    if (!foundAny) {
      // No driver capacity defined for that window/date
      return res.status(409).json({ error: 'driver_full' });
    }

    // Current usage totals (confirmed + fresh pending; includes AdminHold in TOTAL only)
    const { totalCurrent, perDriverCurrent } = await loadWindowUsage(deliveryDate, timeWindow);

    // If total cap is already exhausted (incl. AdminHold), fail as window_full
    const totalCap = Object.values(capsByDriver).reduce((a,b)=>a + (Number(b)||0), 0);
    if (totalCurrent + qtyNeeded > totalCap) {
      const suggestions = await findAlternativeWindows(deliveryDate, timeWindow, qtyNeeded);
      return res.status(409).json({ error: 'window_full', suggestions });
    }

    // Choose least-loaded driver with enough remaining capacity
    const pick = pickDriverLeastLoaded(capsByDriver, perDriverCurrent, qtyNeeded);
    if (!pick) {
      const suggestions = await findAlternativeWindows(deliveryDate, timeWindow, qtyNeeded);
      return res.status(409).json({ error: 'driver_full', suggestions });
    }
    const chosenDriver = pick;

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

/* ------------ Driver-only capacity helpers ------------ */

// Normalize "6:00-7:00 AM", "6:00 – 7:00 am", "6:00–7:00AM" → exactly a value from getWindows()
function normalizeWindow(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  s = s.replace(/\s*-\s*/g, '–').replace(/\s*–\s*/g, '–');
  s = s.replace(/\s*(am|pm)$/i, m => ' ' + m.toUpperCase());
  if (getWindows().includes(s)) return s;
  const tryAm = s.endsWith(' AM') ? s : `${s} AM`;
  const tryPm = s.endsWith(' PM') ? s : `${s} PM`;
  if (getWindows().includes(tryAm)) return tryAm;
  if (getWindows().includes(tryPm)) return tryPm;
  const start = s.split('–')[0];
  return getWindows().find(w => w.startsWith(start)) || '';
}

// Keep in sync with site & Airtable
function getWindows() {
  return ['6:00–7:00 AM', '7:00–8:00 AM', '8:00–9:00 AM'];
}

// Sum DriverCaps and also return per-driver map
async function loadDriverCaps(date, windowLabel) {
  const key  = process.env.AIRTABLE_API_KEY, base = process.env.AIRTABLE_BASE_ID;
  const driverTable = encodeURIComponent(process.env.AIRTABLE_TABLE_DRIVER_CAPS || 'DriverCaps');
  if (!key || !base) return { foundAny: false, capsByDriver: {} };

  const [en, hy] = dashVariants(windowLabel);
  const filter = `AND({Date}='${date}', OR({Window}='${en}', {Window}='${hy}'))`;
  const url = `https://api.airtable.com/v0/${base}/${driverTable}?filterByFormula=${encodeURIComponent(filter)}&pageSize=100`;
  const rows = await readAll(url, { Authorization: 'Bearer ' + key });

  const capsByDriver = {};
  let foundAny = false;
  for (const f of rows) {
    const d = String(f.Driver || '').trim();
    const c = Number(f.Capacity || 0);
    if (!d || !Number.isFinite(c)) continue;
    capsByDriver[d] = (capsByDriver[d] || 0) + c;
    foundAny = true;
  }
  return { foundAny, capsByDriver };
}

// Current usage (confirmed + fresh pending); includes AdminHold in TOTAL
async function loadWindowUsage(date, windowLabel) {
  const key  = process.env.AIRTABLE_API_KEY, base = process.env.AIRTABLE_BASE_ID;
  const slotsTable = encodeURIComponent(process.env.AIRTABLE_TABLE_SLOTS || 'Slots');
  if (!key || !base) return { totalCurrent: 0, perDriverCurrent: {} };

  const [en, hy] = dashVariants(windowLabel);
  const cutoff = new Date(Date.now() - FRESH_MINUTES*60*1000).toISOString();
  const formula = `AND({Date}='${date}', OR({Window}='${en}', {Window}='${hy}'), OR({Status}='confirmed', AND({Status}='pending', IS_AFTER({Updated}, '${cutoff}')), {AdminHold}=1))`;
  const url = `https://api.airtable.com/v0/${base}/${slotsTable}?filterByFormula=${encodeURIComponent(formula)}&pageSize=100`;

  const rows = await readAll(url, { Authorization: 'Bearer ' + key });

  let totalCurrent = 0;
  const perDriverCurrent = {};
  for (const f of rows) {
    const n = Number(f.Items || 0) || 0;
    totalCurrent += n; // AdminHold contributes to total
    if (f.AdminHold) continue; // but not to any driver
    const d = String(f.Driver || '').trim();
    if (d) perDriverCurrent[d] = (perDriverCurrent[d] || 0) + n;
  }
  return { totalCurrent, perDriverCurrent };
}

// Choose least-loaded driver that can fit qtyNeeded
function pickDriverLeastLoaded(capsByDriver, perDriverCurrent, qtyNeeded){
  let best = null, bestLoad = Infinity;
  for (const [d, cap] of Object.entries(capsByDriver)) {
    const used = Number(perDriverCurrent[d] || 0);
    const remain = Number(cap || 0) - used;
    if (remain >= qtyNeeded && used < bestLoad) {
      best = d; bestLoad = used;
    }
  }
  return best;
}

/* ------------ Slots reservation & misc helpers ------------ */

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
    const { foundAny, capsByDriver } = await loadDriverCaps(date, w);
    if (!foundAny) continue;
    const { totalCurrent } = await loadWindowUsage(date, w);
    const totalCap = Object.values(capsByDriver).reduce((a,b)=>a + (Number(b)||0), 0);
    if (totalCurrent + (Number(qtyNeeded) || 1) <= totalCap) out.push(w);
    if (out.length >= 3) break;
  }
  return out;
}

async function safeText(r){
  try { return await r.text(); } catch { return ''; }
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
