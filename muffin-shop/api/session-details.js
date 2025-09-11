// api/session-details.js
// Return Stripe checkout session line items for a given session_id + CORS.
// Auth: X-Admin-Token

import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '', { apiVersion: '2024-06-20' });

export default async function handler(req, res) {
  // CORS
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token');
    res.status(204).end(); return;
  }
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const token = (req.headers['x-admin-token'] || req.query.token || '').toString();
    if (!process.env.ADMIN_API_TOKEN || token !== process.env.ADMIN_API_TOKEN) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    const session_id = (req.query.session_id || '').toString();
    if (!session_id) return res.status(400).json({ ok:false, error:'missing_session_id' });

    const s = await stripe.checkout.sessions.retrieve(session_id, { expand: ['line_items'] });
    const items = (s.line_items?.data || []).map(li => ({
      id: li.id, description: li.description || li.price?.nickname || 'Item', quantity: li.quantity || 1, unit_amount: li.amount_subtotal ?? null
    }));
    res.status(200).json({ ok:true, id: s.id, amount_total: s.amount_total, items });
  } catch (e) {
    console.error('session-details error', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
}
