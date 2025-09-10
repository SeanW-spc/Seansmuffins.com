// api/create-checkout-session.js
// Creates a Stripe Checkout Session + enforces slot capacity via Airtable.
// Also: only shows a Stripe notes field if customer didn’t type notes on-site.

import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '', { apiVersion: '2024-06-20' });

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { items, mode = 'payment', deliveryDate, timeWindow, notes: rawNotes } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'No items provided' });
    if (!deliveryDate || !/^\d{4}-\d{2}-\d{2}$/.test(deliveryDate)) return res.status(400).json({ error: 'deliveryDate (YYYY-MM-DD) required' });
    if (!timeWindow || typeof timeWindow !== 'string') return res.status(400).json({ error: 'timeWindow required' });

    const notes = (rawNotes ? String(rawNotes) : '').slice(0, 500);

    // Capacity check + pending hold
    let reservationId = null;
    if (hasAirtableConfig()) {
      const capacity = parseInt(process.env.SLOT_CAPACITY_DEFAULT || '12', 10);
      const { available, suggestions } = await checkSlotAvailability(deliveryDate, timeWindow, capacity);
      if (!available) {
        return res.status(409).json({ error: 'SLOT_FULL', message: 'That time window is full. Please choose another.', suggestions });
      }
      reservationId = await createPendingReservation({
        deliveryDate,
        timeWindow,
        itemsCount: items.reduce((n, i) => n + (parseInt(i.quantity ?? 1, 10) || 1), 0),
      });
    }

    const params = {
      mode: mode === 'subscription' ? 'subscription' : 'payment',
      allow_promotion_codes: true,
      line_items: items.map(i => ({ price: i.price, quantity: i.quantity || 1 })),
      success_url: `${process.env.NEXT_PUBLIC_SITE_URL || 'https://seansmuffins.com'}/thank-you.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.NEXT_PUBLIC_SITE_URL || 'https://seansmuffins.com'}/`,
      shipping_address_collection: { allowed_countries: ['US'] },
      phone_number_collection: { enabled: true },
      metadata: {
        deliveryDate,
        timeWindow,
        reservationId: reservationId || '',
        order_notes: notes || '',
      },
    };

    // Important: Stripe custom_fields no longer supports "default".
    // We ONLY add a notes custom field if the customer didn’t type notes on-site.
    if (!notes) {
      params.custom_fields = [
        {
          key: 'order_notes',
          label: { type: 'custom', custom: 'Delivery / allergy notes (optional)' },
          type: 'text',
          optional: true,
        },
      ];
    }

    const session = await stripe.checkout.sessions.create(params);
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('create-checkout-session error', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

/* ===== Airtable helpers ===== */
function hasAirtableConfig() {
  return !!(process.env.AIRTABLE_API_KEY && process.env.AIRTABLE_BASE_ID && process.env.AIRTABLE_TABLE_SLOTS);
}
async function checkSlotAvailability(dateStr, windowStr, capacity) {
  const table = encodeURIComponent(process.env.AIRTABLE_TABLE_SLOTS);
  const base = process.env.AIRTABLE_BASE_ID;
  const url = `https://api.airtable.com/v0/${base}/${table}`;
  const filter = `AND({Date}='${dateStr}', {Window}='${windowStr}', OR({Status}='confirmed', AND({Status}='pending', DATETIME_DIFF(NOW(), {Created}, 'minutes') < 60)))`;
  const count = await airtableCount(url, filter);
  const available = count < capacity;

  const WINDOWS = ['6:00–7:00 AM','7:00–8:00 AM','8:00–9:00 AM'];
  const suggestions = [];
  for (const w of WINDOWS) {
    if (w === windowStr) continue;
    const f = `AND({Date}='${dateStr}', {Window}='${w}', OR({Status}='confirmed', AND({Status}='pending', DATETIME_DIFF(NOW(), {Created}, 'minutes') < 60)))`;
    const c = await airtableCount(url, f);
    if (c < capacity) suggestions.push(w);
  }
  return { available, suggestions };
}
async function airtableCount(url, filterByFormula) {
  let offset=null, total=0;
  do {
    const u = new URL(url);
    u.searchParams.set('pageSize','100');
    u.searchParams.set('filterByFormula', filterByFormula);
    if (offset) u.searchParams.set('offset', offset);
    const r = await fetch(u.toString(), { headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` } });
    if (!r.ok) throw new Error(`Airtable count error ${r.status}`);
    const j = await r.json();
    total += (j.records || []).length;
    offset = j.offset;
  } while (offset);
  return total;
}
async function createPendingReservation({ deliveryDate, timeWindow, itemsCount }) {
  const id = (globalThis.crypto?.randomUUID?.() || ('res_' + Math.random().toString(36).slice(2)));
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_TABLE_SLOTS);
  const url = `https://api.airtable.com/v0/${base}/${table}`;
  const body = { records: [{ fields: { ReservationId: id, Date: deliveryDate, Window: timeWindow, Status: 'pending', Items: itemsCount, Created: new Date().toISOString() } }] };
  const r = await fetch(url, { method:'POST', headers:{ Authorization:`Bearer ${process.env.AIRTABLE_API_KEY}`, 'Content-Type':'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) console.error('Airtable reserve failed', r.status, await r.text().catch(()=>'')); // soft-fail
  return id;
}
