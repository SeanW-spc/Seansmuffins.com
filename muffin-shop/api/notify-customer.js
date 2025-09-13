// /api/notify-customer.js
// Sends SMS via Twilio if env is configured; otherwise returns a controlled
// "twilio_unavailable" error so the client fallback (clipboard + sms:) kicks in.

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    }

    // -------- Admin auth (same pattern as your other admin endpoints)
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    const token = bearer || (req.headers['x-admin-token'] || '').trim();
    const allowed = (process.env.ADMIN_API_TOKEN || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!token || !allowed.length || !allowed.includes(token)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const { to, message } = req.body || {};
    if (!to || !message) {
      return res.status(400).json({ ok: false, error: 'missing_fields' });
    }

    // -------- Normalize US numbers to E.164 (+1XXXXXXXXXX)
    const digits = String(to).replace(/\D+/g, '');
    const e164 = digits.length === 10 ? `+1${digits}` : (digits.startsWith('1') && digits.length === 11 ? `+${digits}` : (to.startsWith('+') ? to : null));
    if (!e164) {
      return res.status(400).json({ ok: false, error: 'invalid_phone' });
    }

    // -------- If Twilio not ready, trigger client fallback cleanly
    const SID   = process.env.TWILIO_ACCOUNT_SID || '';
    const TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
    const FROM  = process.env.TWILIO_FROM || ''; // e.g. +18335551234 (toll-free) or +13335551234 (A2P-registered 10DLC)

    if (!SID || !TOKEN || !FROM) {
      // Deliberately use 400 so the UI's try/catch fallback kicks in.
      return res.status(400).json({
        ok: false,
        error: 'twilio_unavailable',
        hint: 'Clipboard + sms: fallback will be used on the client.',
        clipboard: `${e164}\n\n${message}`,
        sms_url: `sms:${encodeURIComponent(e164)}?&body=${encodeURIComponent(message)}`
      });
    }

    // -------- Send via Twilio REST API
    const auth = Buffer.from(`${SID}:${TOKEN}`).toString('base64');
    const body = new URLSearchParams({ To: e164, From: FROM, Body: message });

    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });

    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      // Bubble a controlled error so the UI uses fallback.
      const code = (j && j.code) ? `twilio_${j.code}` : 'twilio_error';
      return res.status(400).json({ ok: false, error: code, detail: j && j.message });
    }

    // Success
    return res.status(200).json({ ok: true, sid: j.sid || null, status: j.status || 'queued' });
  } catch (err) {
    console.error('notify-customer error', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
}
