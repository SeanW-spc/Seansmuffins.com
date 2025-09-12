// api/notify-customer.js
// Sends an SMS to a customer. Auth: X-Admin-Token or Authorization: Bearer <token>
export default async function handler(req, res){
  // CORS
  if (req.method === 'OPTIONS'){
    res.setHeader('Access-Control-Allow-Origin','*');
    res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization, X-Admin-Token');
    return res.status(204).end();
  }
  res.setHeader('Access-Control-Allow-Origin','*');
  if (req.method !== 'POST'){
    res.setHeader('Allow','POST,OPTIONS');
    return res.status(405).json({ ok:false, error:'method_not_allowed' });
  }

  // Auth
  const auth = (req.headers.authorization || '').trim();
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : '';
  const headerToken = (req.headers['x-admin-token'] || '').toString();
  const token = bearer || headerToken || '';
  if (!process.env.ADMIN_API_TOKEN || token !== process.env.ADMIN_API_TOKEN){
    return res.status(401).json({ ok:false, error:'unauthorized' });
  }

  // Read body
  const buf = await new Response(req.body).text();
  let body; try { body = JSON.parse(buf || '{}'); } catch { body = {}; }
  const to = (body.to || '').toString().trim();
  const msg = (body.message || '').toString().trim();
  if (!to || !msg) return res.status(400).json({ ok:false, error:'missing_fields' });

  // Twilio
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const tokenTw = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;
  if (!sid || !tokenTw || !from) return res.status(500).json({ ok:false, error:'twilio_config' });

  const b = new URLSearchParams({ To: to, From: from, Body: msg });
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method:'POST',
    headers:{ 'Authorization':'Basic ' + btoa(`${sid}:${tokenTw}`), 'Content-Type':'application/x-www-form-urlencoded' },
    body:b.toString()
  });
  if (!r.ok){
    const t = await r.text().catch(()=> '');
    return res.status(502).json({ ok:false, error:'twilio_failed', detail:t.slice(0,200) });
  }
  const j = await r.json();
  return res.status(200).json({ ok:true, sid: j.sid });
}
