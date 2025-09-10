// api/stripe-webhook.js
// Confirms/cancels Airtable reservations AND creates an Orders row after payment.
// More robust: if Airtable rejects fields (422), we retry with a minimal safe set.

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
      const full = await stripe.checkout.sessions.retrieve(session.id, { expand: ['line_items'] });

      await createAirtableOrder(full); // insert into Orders
      await markReservation(session?.metadata?.reservationId, 'confirmed', session?.id); // confirm slot
    } else if (event.type === 'checkout.session.expired') {
      const session = event.data.object;
      await markReservation(session?.metadata?.reservationId, 'expired', session?.id);
    }
  } catch (e) {
    console.error('Webhook handler error', e);
    // Still return 200 so Stripe doesn't retry forever
  }

  res.status(200).json({ received: true });
}

/* ===== Slots helpers ===== */
function hasAirtableSlotsConfig() {
  return Boolean(process.env.AIRTABLE_API_KEY && process.env.AIRTABLE_BASE_ID && process.env.AIRTABLE_TABLE_SLOTS);
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
  if (!r.ok) { console.error('Airtable find failed', r.status, await r.text().catch(()=>'')); return; }
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
  if (!upd.ok) console.error('Airtable update failed', upd.status, await upd.text().catch(()=>'')); 
}

/* ===== Orders helpers ===== */
function hasAirtableOrdersConfig() {
  return Boolean(process.env.AIRTABLE_API_KEY && process.env.AIRTABLE_BASE_ID && (process.env.AIRTABLE_TABLE_NAME || 'Orders'));
}

function toE164Maybe(phone) {
  if (!phone) return '';
  const digits = String(phone).replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.length === 10) return `+1${digits}`;
  return digits;
}
function compactAddress(obj) {
  if (!obj || !obj.address) return '';
  const a = obj.address;
  const parts = [a.line1, a.line2, a.city, a.state, a.postal_code, a.country].filter(Boolean);
  return parts.join(', ');
}
function getCustomFieldText(session, key) {
  try {
    const f = (session.custom_fields || []).find(cf => cf.key === key);
    return f && f.type === 'text' && f.text && typeof f.text.value === 'string' ? f.text.value : '';
  } catch { return ''; }
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

  const notesMeta = (session.metadata?.order_notes || '').trim();
  const notesCF   = (getCustomFieldText(session, 'order_notes') || '').trim();
  const combinedNotes = [notesMeta, notesCF].filter(Boolean).join(' | ').slice(0, 1000);

  // Full field set (preferred)
  const fullFields = {
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
  if (combinedNotes) fullFields.notes = combinedNotes;

  // Minimal fallback (works even if single-selects / currency mismatch)
  const minimalFields = {
    customer_name: fullFields.customer_name,
    email: fullFields.email,
    phone: fullFields.phone,
    address: fullFields.address,
    items,
    stripe_session_id: session.id,
    created: fullFields.created,
  };
  if (session.metadata?.deliveryDate) minimalFields.delivery_date = session.metadata.deliveryDate;
  if (session.metadata?.timeWindow) minimalFields.preferred_window = session.metadata.timeWindow;
  if (combinedNotes) minimalFields.notes = combinedNotes;

  // Try full
  let body = { records: [{ fields: fullFields }] };
  let r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });

  if (!r.ok) {
    const txt = await r.text().catch(()=> '');
    console.error('Airtable order create (full) failed', r.status, txt);

    // If it's a validation error (422), retry with minimal
    if (r.status === 422) {
      body = { records: [{ fields: minimalFields }] };
      const r2 = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!r2.ok) {
        console.error('Airtable order create (minimal) failed', r2.status, await r2.text().catch(()=> ''));
      }
    }
  }
}
