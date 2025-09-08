// api/create-checkout-session.js
const Stripe = require('stripe');

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
    const { items } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'No items provided.' });
    }

    // Build robust base URL (works on Vercel)
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const baseUrl = `${proto}://${host}`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: items.map(i => ({ price: i.price, quantity: i.quantity })),
      shipping_address_collection: { allowed_countries: ['US'] },
      phone_number_collection: { enabled: true },
      // Optional custom field:
      // custom_fields: [{
      //   key: 'preferred_window',
      //   label: { type: 'custom', custom: 'Preferred delivery time range' },
      //   type: 'text'
      // }],
      success_url: `${baseUrl}/index.html?checkout=success`,
      cancel_url: `${baseUrl}/index.html?checkout=cancel`
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err);
    return res.status(500).json({ error: err.message || 'Internal Server Error' });
  }
};
