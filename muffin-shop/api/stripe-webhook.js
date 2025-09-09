// api/stripe-webhook.js
// Confirms/cancels Airtable reservations AND creates an Orders row after successful payment.
// Requires STRIPE_WEBHOOK_SECRET when using this route.

import Stripe from 'stripe';

export const config = { api: { bodyParser: false } };

function buffer(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    readable.on('end', () => resolve(Buffer.concat(chunks)));
    readable.on('error', reject);
  });
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '', {
  apiVersion: '2024-06-20',
});

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end('Method Not Allowed');
  }

  const sig = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    const buf = await buffer(req);
    event = stripe.webhooks.constructEvent(buf, sig, secret);
  } catch (err) {
    console.error('Webhook signature verification failed.', err?.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;

      // Retrieve full session with line items
      const full = await stripe.checkout.sessions.retrieve(session.id, { expand: ['line_items'] });

      // 1) Create the Airtable Order (unassigned)
      await createAirtableOrder(full);

      // 2) Confirm the Slot reservation
      await markReservation(session?.metadata?.reservationId, 'confirmed', session?.id);
    } else if (event.type === 'checkout.session.expired') {
      const session = event.data.object;
      await markReservation(session?.metadata?.reservationId, 'expired', session?.id);
    }
  } catch (e) {
    console.error('Webhook handler error', e);
    // Return 200 so Stripe doesn't retry forever if Airtable hiccups.
  }

  res.status(200).json({ received: true });
}

/* ===========================
   Airtable helpers for SLOTS
   =========================== */
function hasAirtableSlotsConfig() {
  return Boolean(
    process.env.AIRTABLE_API_KEY &&
    process.env.AIRTABLE_BASE_ID &&
    process.env.AIRTABLE_TABLE_SLOTS
  );
}

async function markReservation(reservationId, status, sessionId) {
  if (!reservationId || !hasAirtableSlotsConfig()) return;

  const table = encodeURIComponent(process.env.AIRTABLE_TABLE_SLOTS);
  const base = process.env.AIRTABLE_BASE_ID;
  const url = `https://api.airtable.com/v0/${base}/${table}`;

  // Find record by ReservationId
  const findUrl = new URL(url);
  findUrl.searchParams.set('filterByFormula', `({ReservationId}='${reservationId}')`);
  const r = await fetch(findUrl.toString(), { headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` } });
  if (!r.ok) { console.error('Airtable find failed', r.status); return; }
  const data = await r.json();
  const rec = (data.records || [])[0];
  if (!rec) return;

  const upd = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      records: [{
        id: rec.id,
        fields: {
          Status: status,
          SessionId: sessionId || '',
          Updated: new Date().toISOString(),
        }
      }]
    })
  });
  if (!upd.ok) console.error('Airtable update failed', upd.status, await upd.text());
}

/* ===========================
   Airtable helpers for ORDERS
   =========================== */
function hasAirtableOrdersConfig() {
  return Boolean(
    process.env.AIRTABLE_API_KEY &&
    process.env.AIRTABLE_BASE_ID &&
    (process.env.AIRTABLE_TABLE_NAME || 'Orders')
  );
}

function toE164Maybe(phone) {
  if (!phone) return '';
  const digits = String(phone).replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  // US default
  if (digits.length === 10) return `+1${digits}`;
  return digits;
}

function compactAddress(obj) {
  if (!obj || !obj.address) return '';
  const a = obj.address;
  const parts = [
    a.line1, a.line2, a.city, a.state, a.postal_code, a.country
  ].filter(Boolean);
  return parts.join(', ');
}

async function createAirtableOrder(session) {
  if (!hasAirtableOrdersConfig()) return;

  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || 'Orders');
  const url = `https://api.airtable.com/v0/${base}/${table}`;
  const headers = {
    Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
    'Content-Type': 'application/json'
  };

  const cd = session.customer_details || {};
  const shipping = session.shipping_details || {};
  const items = (session.line_items?.data || []).map(li => {
    const name = li.description || (li.price?.nickname || 'Item');
    const qty = li.quantity || 1;
    return `${name} x${qty}`;
  }).join(', ');

  const fields = {
    delivery_date: session.metadata?.deliveryDate || '',
    preferred_window: session.metadata?.timeWindow || '',
    status: 'unassigned',
    delivery_time: '',
    route_position: null,

    customer_name: cd.name || shipping.name || '',
    email: cd.email || '',
    phone: toE164Maybe(cd.phone || ''),

    address: compactAddress(shipping),
    items,
    total: (session.amount_total ?? 0) / 100,
    stripe_session_id: session.id,
    created: new Date().toISOString(),
  };

  const body = { records: [{ fields }] };
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!r.ok) {
    const t = await r.text();
    console.error('Airtable order create failed', r.status, t);
  }
}
