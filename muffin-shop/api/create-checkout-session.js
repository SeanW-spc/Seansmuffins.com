// api/create-checkout-session.js
// Creates a Stripe Checkout Session with:
// - price preflight (prevents sub/one-time mismatches)
// - optional Airtable capacity hold (soft-fails if Airtable hiccups)
// - phone + US shipping address collection
// - custom field for notes in Stripe
// - passes site "notes" through metadata to the webhook
// - clear error messages back to the client

import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '', {
  apiVersion: '2024-06-20',
});

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'METHOD_NOT_ALLOWED', message: 'Use POST' });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({
      error: 'STRIPE_CONFIG_MISSING',
      message: 'Server is missing STRIPE_SECRET_KEY.',
    });
  }

  try {
    const { items, mode = 'payment', deliveryDate, timeWindow, notes: rawNotes } = req.body || {};

    // --- Basic validation
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'No items provided.' });
    }
    if (!deliveryDate || !/^\d{4}-\d{2}-\d{2}$/.test(deliveryDate)) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'deliveryDate (YYYY-MM-DD) required.' });
    }
    if (!timeWindow || typeof timeWindow !== 'string') {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'timeWindow required.' });
    }
    const notes = (rawNotes ? String(rawNotes) : '').slice(0, 500); // keep it reasonable

    // --- Stripe price preflight (catch bad IDs + mode mismatches early)
    const uniquePriceIds = [...new Set(items.map(i => String(i.price || '')))].filter(Boolean);
    const prices = await Promise.all(uniquePriceIds.map(id => stripe.prices.retrieve(id)));
    const mapRecurring = new Map(prices.map(p => [p.id, Boolean(p.recurring)]));

    const isSubscription = String(mode).toLowerCase() === 'subscription';
    const anyRecurring = items.some(i => mapRecurring.get(i.price) === true);
    const anyOneTime   = items.some(i => mapRecurring.get(i.price) === false);

    if (!isSubscription && anyRecurring) {
      return res.status(400).json({
        error: 'RECURRING_IN_PAYMENT_MODE',
        message: 'Cart contains a subscription price but checkout mode is payment. Use Subscribe, or remove subscription items.',
      });
    }
    if (isSubscription && anyOneTime) {
      return res.status(400).json({
        error: 'ONETIME_IN_SUBSCRIPTION_MODE',
        message: 'Subscription checkout only supports recurring prices. Remove one-time items or use standard checkout.',
      });
    }

    // --- Optional capacity check + pending hold in Airtable (soft-fail on errors)
    let reservationId = null;
    try {
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
        reservationId = await createPendingReservation({
          deliveryDate,
          timeWindow,
          itemsCount: items.reduce((n, i) => n + (parseInt(i.quantity ?? 1, 10) || 1), 0),
        });
      }
    } catch (airErr) {
      console.error('Airtable capacity check failed – proceeding without capacity gate:', airErr);
      reservationId = null; // continue without blocking checkout
    }

    // --- Create Checkout Session
    const session = await stripe.checkout.sessions.create({
      mode: isSubscription ? 'subscription' : 'payment',
      allow_promotion_codes: true,
      line_items: items.map(i => ({
        price: i.price,
        quantity: i.quantity || 1,
      })),
      success_url: `${process.env.NEXT_PUBLIC_SITE_URL || 'https://seansmuffins.com'}/thank-you.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.NEXT_PUBLIC_SITE_URL || 'https://seansmuffins.com'}/`,
      phone_number_collection: { enabled: true },
      shipping_address_collection: { allowed_countries: ['US'] },

      // Let customers add notes directly on Stripe too
      custom_fields: [
        {
          key: 'order_notes',
          label: { type: 'custom', custom: 'Delivery / allergy notes (optional)' },
          type: 'text',
          optional: true,
        },
      ],

      // Your site-provided notes and delivery choices travel via metadata
      metadata: {
        deliveryDate,
        timeWindow,
        reservationId: reservationId || '',
        order_notes: notes || '',
      },
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    const msg = String(err?.message || 'Server error');
    const code = String(err?.code || 'UNKNOWN');
    const status =
      (code === 'resource_missing' || /No such/i.test(msg)) ? 400 :
      (code === 'validation_error') ? 400 :
      500;

    console.error('create-checkout-session error', { code, msg });
    return res.status(status).json({
      error: 'CHECKOUT_CREATE_FAILED',
      message: msg,
      code,
    });
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
  const table = encodeURIComponent(process.env.AIRTABLE_TABLE_SLOTS);
  const base  = process.env.AIRTABLE_BASE_ID;
  const url   = `https://api.airtable.com/v0/${base}/${table}`;

  const formula =
    `AND({Date}='${dateStr}', {Window}='${windowStr}', OR({Status}='confirmed', AND({Status}='pending', DATETIME_DIFF(NOW(), {Created}, 'minutes') < 60)))`;

  const count = await airtableCount(url, formula);
  const available = count < capacity;

  // Suggestions (same date, other windows)
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
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error(`Airtable count error ${r.status}: ${t}`);
    }
    const data = await r.json();
    total += (data.records || []).length;
    offset = data.offset;
  } while (offset);
  return total;
}

function getWindows() { return ['6:00–7:00 AM', '7:00–8:00 AM', '8:00–9:00 AM']; }

async function createPendingReservation({ deliveryDate, timeWindow, itemsCount }) {
  const id = (globalThis.crypto?.randomUUID?.() || randomId());
  const table = encodeURIComponent(process.env.AIRTABLE_TABLE_SLOTS);
  const base  = process.env.AIRTABLE_BASE_ID;
  const url   = `https://api.airtable.com/v0/${base}/${table}`;

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
    const t = await r.text().catch(() => '');
    console.error('Airtable reserve failed', r.status, t);
    return id; // soft-fail: still allow checkout
  }
  return id;
}

function randomId() {
  return 'res_' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}
