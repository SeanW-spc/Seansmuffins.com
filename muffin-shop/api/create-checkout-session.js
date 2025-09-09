// api/create-checkout-session.js
const Stripe = require('stripe');

function tomorrowISO(tz = 'America/New_York') {
  const now = new Date();
  // add 1 day in UTC then format in ET
  const plus1 = new Date(now.getTime() + 24*60*60*1000);
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' });
  const [y,m,d] = fmt.format(plus1).split('-');
  return `${y}-${m}-${d}`; // YYYY-MM-DD
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    return res.status(500).json({ error: 'Missing STRIPE_SECRET_KEY env var' });
  }

  const stripe = new Stripe(secret, { apiVersion: '2024-06-20' });

  try {
    const { items, mode: rawMode } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'No items provided.' });
    }
    const mode = (rawMode === 'subscription') ? 'subscription' : 'payment';

    // Build base URL for redirects
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const baseUrl = `${proto}://${host}`;

    const session = await stripe.checkout.sessions.create({
      mode,
      line_items: items.map(i => ({ price: i.price, quantity: i.quantity })),
      shipping_address_collection: { allowed_countries: ['US'] },
      phone_number_collection: { enabled: true },

      // 👇 NEW: collect delivery date + preferred time window
      custom_fields: [
        {
          key: 'delivery_date',
          label: { type: 'custom', custom: 'Preferred delivery date (YYYY-MM-DD)' },
          type: 'text',
          optional: false,
          text: {
            // Prefill to tomorrow; customer can edit
            default_value: tomorrowISO(),
            maximum_length: 10
          }
        },
        {
          key: 'preferred_window',
          label: { type: 'custom', custom: 'Preferred delivery time range' },
          type: 'text',
          optional: false,
          text: {
            default_value: '7:30–8:30 AM',
            maximum_length: 40
          }
        }
      ],

      // (Nice to have: mirror into metadata too)
      // metadata: { delivery_date: tomorrowISO(), preferred_window: '7:30–8:30 AM' },

      success_url: `${baseUrl}/index.html?checkout=success`,
      cancel_url: `${baseUrl}/index.html?checkout=cancel`
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err);
    return res.status(500).json({ error: err.message || 'Internal Server Error' });
  }
};
