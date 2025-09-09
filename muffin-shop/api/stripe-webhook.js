// api/stripe-webhook.js
const Stripe = require('stripe');

// Stripe needs the raw body
module.exports.config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => resolve(Buffer.from(data)));
    req.on('error', reject);
  });
}

function parseAddress(addr = {}) {
  const parts = [
    addr.line1,
    addr.line2,
    [addr.city, addr.state, addr.postal_code].filter(Boolean).join(' ').trim(),
    addr.country
  ].filter(Boolean);
  return parts.join('\n');
}
function parsePreferredWindow(custom_fields = []) {
  const f = custom_fields.find(x => x.key === 'preferred_window');
  return (f && f.text && f.text.value) || '';
}
function todayISO(tz = 'America/New_York') {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const [y, m, d] = fmt.format(now).split('-');
  return `${y}-${m}-${d}`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('Method Not Allowed');
  }

  const secret = process.env.STRIPE_SECRET_KEY;
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !whSecret) return res.status(500).send('Missing Stripe env vars');

  const stripe = new Stripe(secret, { apiVersion: '2024-06-20' });

  const sig = req.headers['stripe-signature'];
  if (!sig) return res.status(400).send('Missing Stripe-Signature');

  let event;
  try {
    const rawBody = await readRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, whSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
  }

  if (event.type !== 'checkout.session.completed') {
    return res.status(200).json({ received: true });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(event.data.object.id, {
      expand: ['line_items', 'customer_details', 'shipping_details']
    });

    const items = (session.line_items?.data || []).map(li => ({
      name: li.description,
      qty: li.quantity
    }));

    const address = parseAddress(session.shipping_details?.address || {});
    const preferredWindow = parsePreferredWindow(session.custom_fields || []);
    const total = (session.amount_total ?? 0) / 100;

    const baseId = process.env.AIRTABLE_BASE_ID;
    const tableName = process.env.AIRTABLE_TABLE_NAME || 'Orders';
    const apiKey = process.env.AIRTABLE_API_KEY;
    if (!baseId || !apiKey) throw new Error('Missing Airtable env vars');

    const atRes = await fetch(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        records: [{
          fields: {
            order_id: session.id,
            created_at: new Date().toISOString(),
            customer_name: session.customer_details?.name || '',
            email: session.customer_details?.email || '',
            phone: session.customer_details?.phone || '',
            address,
            items: items.map(i => `${i.name} x${i.qty}`).join('\n'),
            quantity_total: items.reduce((n,i)=>n+(i.qty||0),0),
            preferred_window: preferredWindow,
            delivery_date: todayISO(),
            delivery_time: '',
            route_position: null,
            status: 'unassigned',
            total
          }
        }]
      })
    });

    if (!atRes.ok) {
      const txt = await atRes.text();
      throw new Error(`Airtable failed: ${atRes.status} ${txt}`);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Webhook handling error:', err.message);
    return res.status(500).json({ error: err.message || 'Internal' });
  }
};
