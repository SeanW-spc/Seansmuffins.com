// api/stripe-webhook.js
// Confirms/cancels Airtable reservations AND inserts an Orders row after payment.
// Logs meaningful errors if Airtable rejects a write.

import Stripe from 'stripe';

export const config = { api: { bodyParser: false } };

function buffer(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on('data', (c) => chunks.push(Buffer.from(c)));
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
  if (!secret) {
    console.error('Missing STRIPE_WEBHOOK_SECRET');
    return res.status(500).end('Server misconfigured');
  }

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
      const sessId = event.data.object.id;
      const session = await stripe.checkout.sessions.retrieve(sessId, { expand: ['line_items'] });
      await createAirtableOrder(session);                         // write to Orders
      await markReservation(session?.metadata?.reservationId, 'confirmed', session?.id); // confirm Slot
    } else if (event.type === 'checkout.session.expired') {
      const session = event.data.object;
      await markReservation(session?.metadata?.reservationId, 'expired', session?.id);
    }
  } catch (e) {
    console.error('Webhook handler error', e);
    // Return 200 so Stripe doesn’t retry forever; you’ll still see the error in Vercel logs.
  }

  res.status(200).json({ received: true });
}

/* ===== Slots helpers ===== */
function hasSlotsEnv() {
  return Boolean(process.env.AIRTABLE_API_KEY && process.env.AIRTABLE_BASE_ID && process.env.AIRTABLE_TABLE_SLOTS);
}

async function markReservation(reservationId, status, sessionId) {
  if (!reservationId || !hasSlotsEnv()) return;

  const table = encodeURIComponent(process.env.AIRTABLE_TABLE_SLOTS);
  const base = process.env.AIRTABLE_BASE_ID;
  const url = `https://api.airtable.com/v0/${base}/${table}`;

  // Find record by ReservationId
  const findUrl = new URL(url);
  findUrl.searchParams.set('filterByFormula', `({ReservationId}='${reservationId}')`);
  const r = await fetch(findUrl.toString(), { headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` } });
  if (!r.ok) { console.error('Airtable Slots find failed', r.status, await r.text().catch(()=>'')); return; }
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
  if (!upd.ok) console.error('Airtable Slots update failed', upd.status, await upd.text().catch(()=>'')); 
}

/* ===== Orders insert ===== */
function hasOrdersEnv() {
  return Boolean(process.env.AIRTABLE_API_KEY && process.env.AIRTABLE_BASE_ID && (process.env.AIRTABLE_TABLE_NAME || 'Orders'));
}

function toE164Maybe(phone) {
  if (!phone) return '';
  const d = String(phone).replace(/[^\d+]/g, '');
  if (d.startsWith('+')) return d;
  if (d.length === 10) return `+1${d}`;
  return d;
}
function compactAddress(obj) {
  if (!obj || !obj.address) return '';
  const a = obj.address;
  return [a.line1, a.line2, a.city, a.state, a.postal_code, a.country].filter(Boolean).join(', ');
}
function getCustomFieldText(session, key) {
  try {
    const f = (session.custom_fields || []).find(cf => cf.key === key);
    return f && f.type === 'text' && f.text && typeof f.text.value === 'string' ? f.text.value : '';
  } catch { return ''; }
}

async function createAirtableOrder(session) {
  if (!hasOrdersEnv()) return;

  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || 'Orders');
  const url = `https://api.airtable.com/v0/${base}/${table}`;
  const headers = {
    Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
    'Content-Type': 'application/json'
  };

  const cd = session.customer_details || {};
  const shipping = session.shipping_details || {};
  const lineItems = session.line_items?.data || [];
  const itemsStr = lineItems.map(li => `${li.description || li.price?.nickname || 'Item'} x${li.quantity || 1}`).join(', ');

  const notesMeta = (session.metadata?.order_notes || '').trim();
  const notesCF   = (getCustomFieldText(session, 'order_notes') || '').trim();
  const notes = [notesMeta, notesCF].filter(Boolean).join(' | ').slice(0, 1000);

  // Fields your table should have (see step 0)
  const fields = {
    stripe_session_id: session.id,
    delivery_date: session.metadata?.deliveryDate || '',
    preferred_window: session.metadata?.timeWindow || '',
    status: 'unassigned',
    delivery_time: '',
    route_position: null,

    customer_name: cd.name || shipping.name || '',
    email: cd.email || '',
    phone: toE164Maybe(cd.phone || ''),
    address: compactAddress(shipping),

    // items is optional; we only set it if your table has it
    // items: itemsStr,

    total: (session.amount_total ?? 0) / 100,
    created: new Date().toISOString(),
  };
  if (notes) fields.notes = notes;

  // Try full write
  let r = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ records: [{ fields }] }) });
  if (!r.ok) {
    const txt = await r.text().catch(()=> '');
    console.error('Airtable Orders insert failed', r.status, txt);
  } else {
    console.log('Airtable Orders insert OK for session', session.id);
  }
}
