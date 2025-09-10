// api/session-summary.js
// Returns a safe summary of a Checkout Session to render on thank-you.html.

import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '', {
  apiVersion: '2024-06-20',
});

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
  }
  const { session_id } = req.query || {};
  if (!session_id) {
    return res.status(400).json({ error: 'MISSING_SESSION_ID' });
  }

  try {
    const s = await stripe.checkout.sessions.retrieve(String(session_id), {
      expand: ['line_items'],
    });

    // Combine notes from metadata + custom field (if used)
    const cfNotes = (() => {
      try {
        const f = (s.custom_fields || []).find(cf => cf.key === 'order_notes');
        return f && f.type === 'text' && f.text && typeof f.text.value === 'string'
          ? f.text.value : '';
      } catch { return ''; }
    })();

    const notes = [String(s.metadata?.order_notes || '').trim(), String(cfNotes || '').trim()]
      .filter(Boolean).join(' | ').slice(0, 1000);

    const items = (s.line_items?.data || []).map(li => ({
      name: li.description || li.price?.nickname || 'Item',
      quantity: li.quantity || 1,
      amount_each: typeof li.price?.unit_amount === 'number' ? li.price.unit_amount / 100 : null,
      currency: s.currency || 'usd',
    }));

    const data = {
      id: s.id,
      status: s.status,
      amount_total: (s.amount_total ?? 0) / 100,
      currency: s.currency || 'usd',

      delivery_date: s.metadata?.deliveryDate || '',
      preferred_window: s.metadata?.timeWindow || '',
      notes,

      customer: {
        name: s.customer_details?.name || s.shipping_details?.name || '',
        email: s.customer_details?.email || '',
        phone: s.customer_details?.phone || '',
      },
      address: (() => {
        const a = s.shipping_details?.address || {};
        const parts = [a.line1, a.line2, a.city, a.state, a.postal_code, a.country].filter(Boolean);
        return parts.join(', ');
      })(),

      items,
    };

    res.status(200).json(data);
  } catch (err) {
    console.error('session-summary error', err?.message);
    res.status(400).json({ error: 'INVALID_SESSION', message: String(err?.message || '') });
  }
}
