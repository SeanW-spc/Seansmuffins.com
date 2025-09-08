// File: muffin-shop/api/create-checkout-session.js
import Stripe from 'stripe';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2024-06-20', // or latest available for your account
  });

  try {
    const { items, success_url, cancel_url } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'No items provided.' });
    }

    // Derive domain for success/cancel if not provided
    const proto = (req.headers['x-forwarded-proto'] || 'https');
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const baseUrl = `${proto}://${host}`;
    const successURL = success_url || `${baseUrl}/index.html?checkout=success`;
    const cancelURL = cancel_url || `${baseUrl}/index.html?checkout=cancel`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: items.map(i => ({ price: i.price, quantity: i.quantity })),
      // Collect shipping address (so you have delivery info)
      shipping_address_collection: { allowed_countries: ['US'] },
      // Optional: collect phone
      phone_number_collection: { enabled: true },
      // Optional: add custom fields for delivery window
      // custom_fields: [{
      //   key: 'preferred_window',
      //   label: { type: 'custom', custom: 'Preferred delivery time range' },
      //   type: 'text',
      // }],
      success_url: successURL,
      cancel_url: cancelURL,
      // Optional: automatic tax, if you enable in Dashboard
      // automatic_tax: { enabled: true },
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err);
    return res.status(500).json({ error: err.message || 'Internal Server Error' });
  }
}
// muffin-shop/api/create-checkout-session.js
const Stripe = require('stripe');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

  try {
    const { items, success_url, cancel_url } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'No items provided.' });
    }
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const baseUrl = `${proto}://${host}`;
    const successURL = success_url || `${baseUrl}/index.html?checkout=success`;
    const cancelURL  = cancel_url  || `${baseUrl}/index.html?checkout=cancel`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: items.map(i => ({ price: i.price, quantity: i.quantity })),
      shipping_address_collection: { allowed_countries: ['US'] },
      phone_number_collection: { enabled: true },
      // Uncomment to force a custom field:
      // custom_fields: [{
      //   key: 'preferred_window',
      //   label: { type: 'custom', custom: 'Preferred delivery time range' },
      //   type: 'text',
      // }],
      success_url: successURL,
      cancel_url: cancelURL,
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err);
    return res.status(500).json({ error: err.message || 'Internal Server Error' });
  }
};
