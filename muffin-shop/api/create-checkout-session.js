// api/create-checkout-session.js
// Creates a Stripe Checkout Session *and* (optionally) enforces slot capacity.
// If Airtable env vars are not present, capacity checks are skipped (everything allowed).

import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '', {
  apiVersion: '2024-06-20',
});

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { items, mode = 'payment', deliveryDate, timeWindow } = req.body || {};

    // Basic validations
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'No items provided' });
    }
    if (!deliveryDate || !/^\d{4}-\d{2}-\d{2}$/.test(deliveryDate)) {
      return res.status(400).json({ error: 'deliveryDate (YYYY-MM-DD) required' });
    }
    if (!timeWindow || typeof timeWindow !== 'string') {
      return res.status(400).json({ error: 'timeWindow required' });
    }

    // Optional: enforce capacity via Airtable "Slots"
    let reservationId = null;
    if (hasAirtableConfig()) {
      const capacity = parseInt(process.env.SLOT_CAPACITY_DEFAULT || '12', 10);
      const { available, suggestions } = await checkSlotAvailability(deliveryDate, timeWindow, capacity);
      if (!available) {
        return res.status(409).json({
          error: 'SLOT_FULL',
          message: 'That time window is full. Please choose another.',
          suggestions,
        });
      }
      // Reserve a spot (pending) to prevent race conditions
      reservationId = await createPendingReservation({
        deliveryDate,
        timeWindow,
        itemsCount: items.reduce((n, i) => n + (parseInt(i.quantity ?? 1, 10) || 1), 0),
      });
    }

    // Create checkout session — collect shipping address + phone for delivery
    const session = await stripe.checkout.sessions.create({
      mode: mode === 'subscription' ? 'subscription' : 'payment',
      allow_promotion_codes: true,
      line_items: items.map(i => ({ price: i.price, quantity: i.quantity || 1 })),
      success_url: `${process.env.NEXT_PUBLIC_SITE_URL || 'https://seansmuffins.com'}/thank-you.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.NEXT_PUBLIC_SITE_URL || 'https://seansmuffins.com'}/`,
      metadata: {
        deliveryDate,
        timeWindow,
        reservationId: reservationId || '',
      },
      // NEW: ask Stripe Checkout to collect phone + shipping address
      phone_number_collection: { enabled: true },
      shipping_address_collection: { allowed_countries: ['US'] },
      custom_fields: [
        {
          key: 'delivery_date',
          label: { type: 'custom', custom: 'Delivery date' },
          type: 'text',
          default: deliveryDate,
        },
        {
          key: 'preferred_time',
          label: { type: 'custom', custom: 'Preferred time window' },
          type: 'text',
          default: timeWindow,
        },
      ],
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('create-checkout-session error', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

/* ===========================
   Airtable helpers (optional)
   =========================== */
function hasAirtableConfig() {
  return Boolean(
    process.env.AIRTABLE_API_KEY &&
    process.env.AIRTABLE_BASE_ID &&
    process.env.AIRTABLE_TABLE_SLOTS
  );
}

async function checkSlotAvailability(dateStr, windowStr, capacity) {
  // Count confirmed + "fresh" pending (age < 60 minutes)
  const table = encodeURIComponent(process.env.AIRTABLE_TABLE_SLOTS);
  const base = process.env.AIRTABLE_BASE_ID;
  const url = `https://api.airtable.com/v0/${base}/${table}`;

  const formula =
    `AND({Date}='${dateStr}', {Window}='${windowStr}', OR({Status}='confirmed', AND({Status}='pending', DATETIME_DIFF(NOW(), {Created}, 'minutes') < 60)))`;

  const count = await airtableCount(url, formula);
  const available = count < capacity;

  // Also compute suggestions (other windows with space)
  const WINDOWS = getWindows();
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
  let offset = null, total = 0;
  do {
    const query = new URL(url);
    query.searchParams.set('pageSize', '100');
    query.searchParams.set('filterByFormula', filterByFormula);
    if (offset) query.searchParams.set('offset', offset);

    const r = await fetch(query.toString(), {
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
    });
    if (!r.ok) throw new Error(`Airtable count error ${r.status}`);
    const data = await r.json();
    total += (data.records || []).length;
    offset = data.offset;
  } while (offset);
  return total;
}

function getWindows() {
  // Keep in sync with UI
  return ['6:00–7:00 AM', '7:00–8:00 AM', '8:00–9:00 AM'];
}

async function createPendingReservation({ deliveryDate, timeWindow, itemsCount }) {
  const id = (globalThis.crypto?.randomUUID?.() || randomId());
  const table = encodeURIComponent(process.env.AIRTABLE_TABLE_SLOTS);
  const base = process.env.AIRTABLE_BASE_ID;
  const url = `https://api.airtable.com/v0/${base}/${table}`;

  const body = {
    records: [{
      fields: {
        ReservationId: id,
        Date: deliveryDate,
        Window: timeWindow,
        Status: 'pending',
        Items: itemsCount,
        Created: new Date().toISOString(),
      }
    }]
  };

  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const t = await r.text();
    console.error('Airtable reserve error', r.status, t);
    // If reservation fails, allow checkout anyway (to avoid blocking legit orders)
    return id;
  }
  return id;
}

function randomId() {
  return 'res_' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}
