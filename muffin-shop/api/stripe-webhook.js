// api/stripe-webhook.js
// Confirms/cancels Airtable reservations based on Stripe events.
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
      await markReservation(session?.metadata?.reservationId, 'confirmed', session?.id);
    } else if (event.type === 'checkout.session.expired') {
      const session = event.data.object;
      await markReservation(session?.metadata?.reservationId, 'expired', session?.id);
    } else if (event.type === 'checkout.session.async_payment_failed' || event.type === 'checkout.session.async_payment_succeeded') {
      // no-op
    }
  } catch (e) {
    console.error('Webhook handler error', e);
    // We still return 200 so Stripe doesn't retry forever if Airtable hiccups.
  }

  res.status(200).json({ received: true });
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

async function markReservation(reservationId, status, sessionId) {
  if (!reservationId || !hasAirtableConfig()) return;

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
