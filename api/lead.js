// ============================================================
// Lead capture — Supabase insert
// Vercel Serverless Function — runtime: nodejs20 (native fetch)
// ============================================================
// Receives form POSTs from the landing pages, validates server-side,
// and inserts a row into Supabase `public.leads`.
//
// Required env vars (set in Vercel project settings):
//   SUPABASE_URL                e.g. https://eqppnblxyxmslhgxiror.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY   service_role JWT — full DB access — SERVER ONLY
// ============================================================

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Whitelist of fields we accept from the client. Anything else is dropped.
const STRING_FIELDS = [
  'source_page', 'form_type', 'event_source_url',
  'email', 'phone', 'first_name', 'last_name', 'zip',
  'fbclid', 'gclid',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'referrer'
];
const UUID_FIELDS = ['event_id'];
const BOOL_FIELDS = ['consent_sms'];
const HONEYPOT_FIELDS = ['company', 'linkedin', 'website']; // Gravity Forms style honeypots

function clamp(v, max = 500) {
  if (typeof v !== 'string') return v;
  return v.length > max ? v.slice(0, max) : v;
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (!fwd) return req.socket?.remoteAddress || null;
  return String(fwd).split(',')[0].trim();
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SERVICE_KEY) {
    // Fail open — don't break the user's signup UX if backend is misconfigured
    return res.status(200).json({ ok: false, reason: 'supabase_not_configured' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  // Honeypot — if any of these are filled, it's a bot. Pretend success.
  for (const hp of HONEYPOT_FIELDS) {
    if (body[hp]) {
      return res.status(200).json({ ok: true, captured: false });
    }
  }

  // Build whitelisted payload
  const lead = {};
  for (const k of STRING_FIELDS) {
    if (body[k] !== undefined && body[k] !== null && body[k] !== '') {
      lead[k] = clamp(String(body[k]).trim());
    }
  }
  for (const k of UUID_FIELDS) {
    if (body[k] && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body[k])) {
      lead[k] = body[k];
    }
  }
  for (const k of BOOL_FIELDS) {
    lead[k] = !!body[k];
  }

  // Normalize email
  if (lead.email) {
    lead.email = lead.email.toLowerCase();
    if (!EMAIL_RE.test(lead.email)) {
      return res.status(400).json({ ok: false, reason: 'invalid_email' });
    }
  }

  // Server-captured context
  lead.ip = getClientIp(req);
  lead.user_agent = clamp(req.headers['user-agent'] || '', 1000);
  if (!lead.referrer) lead.referrer = clamp(req.headers.referer || '', 500);
  if (!lead.event_source_url) lead.event_source_url = lead.referrer;

  // Require at least an email OR a zip to be a useful lead
  if (!lead.email && !lead.zip) {
    return res.status(400).json({ ok: false, reason: 'insufficient_data' });
  }

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/leads`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SERVICE_KEY,
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(lead)
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!r.ok) {
      console.error('Supabase insert failed', r.status, data);
      return res.status(200).json({ ok: false, status: r.status });
    }
    return res.status(200).json({ ok: true, id: Array.isArray(data) ? data[0]?.id : data?.id });
  } catch (err) {
    console.error('Lead capture error', err);
    return res.status(200).json({ ok: false, reason: 'fetch_failed' });
  }
}
