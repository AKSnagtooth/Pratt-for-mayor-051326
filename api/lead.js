// ============================================================
// Lead capture — Supabase insert
// Vercel Serverless Function — runtime: nodejs20 (native fetch)
// ============================================================
// Receives form POSTs from the landing pages, validates server-side,
// rate-limits by IP, verifies Cloudflare Turnstile (if configured),
// and inserts a row into Supabase `public.leads`.
//
// Required env vars (set in Vercel project settings):
//   SUPABASE_URL                  e.g. https://eqppnblxyxmslhgxiror.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY     service_role JWT — full DB access — SERVER ONLY
// Optional env vars:
//   TURNSTILE_SECRET_KEY          Cloudflare Turnstile secret. If set, captcha
//                                 verification is enforced. If unset, captcha
//                                 is skipped (graceful degradation).
//   RATE_LIMIT_PER_HOUR           Default 5. Max leads per IP per hour.
// ============================================================

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const STRING_FIELDS = [
  'source_page', 'form_type', 'event_source_url',
  'email', 'phone', 'first_name', 'last_name', 'zip',
  'fbclid', 'gclid',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'referrer'
];
const UUID_FIELDS = ['event_id'];
const BOOL_FIELDS = ['consent_sms'];
const HONEYPOT_FIELDS = ['company', 'linkedin', 'website'];

function clamp(v, max = 500) {
  if (typeof v !== 'string') return v;
  return v.length > max ? v.slice(0, max) : v;
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (!fwd) return req.socket?.remoteAddress || null;
  return String(fwd).split(',')[0].trim();
}

// ============================================================
// Cloudflare Turnstile verification
// ============================================================
async function verifyTurnstile(token, ip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  // No secret configured → skip verification (graceful degradation)
  if (!secret) return { ok: true, skipped: true };
  if (!token) return { ok: false, reason: 'no_token' };
  try {
    const formData = new URLSearchParams();
    formData.append('secret', secret);
    formData.append('response', token);
    if (ip) formData.append('remoteip', ip);
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: formData
    });
    const json = await r.json();
    return { ok: !!json.success, raw: json };
  } catch (e) {
    console.error('Turnstile verify failed', e);
    // On verifier outage, fail open to avoid blocking legitimate leads.
    return { ok: true, error: e.message };
  }
}

// ============================================================
// Rate limit check via existing leads table
// Count leads from same IP in last hour
// ============================================================
async function isRateLimited(ip, supabaseUrl, serviceKey) {
  if (!ip) return false;
  const limit = parseInt(process.env.RATE_LIMIT_PER_HOUR || '5', 10);
  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const url = `${supabaseUrl}/rest/v1/leads?ip=eq.${encodeURIComponent(ip)}&created_at=gte.${encodeURIComponent(oneHourAgo)}&select=id`;
    const r = await fetch(url, {
      method: 'GET',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Range': '0-50',
        'Prefer': 'count=exact'
      }
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = []; }
    const count = Array.isArray(data) ? data.length : 0;
    return count >= limit;
  } catch (e) {
    console.error('Rate limit check failed', e);
    return false; // Fail open
  }
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

  const ip = getClientIp(req);

  // 1. Rate limit by IP (before any expensive work)
  if (await isRateLimited(ip, SUPABASE_URL, SERVICE_KEY)) {
    console.warn('Rate limited', ip);
    // Return 429 so the client knows but don't leak the threshold
    return res.status(429).json({ ok: false, reason: 'rate_limited' });
  }

  // 2. Turnstile captcha (if configured)
  const turnstileCheck = await verifyTurnstile(body.turnstile_token, ip);
  if (!turnstileCheck.ok) {
    console.warn('Turnstile failed', turnstileCheck);
    return res.status(403).json({ ok: false, reason: 'captcha_failed' });
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
  lead.ip = ip;
  lead.user_agent = clamp(req.headers['user-agent'] || '', 1000);
  if (!lead.referrer) lead.referrer = clamp(req.headers.referer || '', 500);
  if (!lead.event_source_url) lead.event_source_url = lead.referrer;

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
    const newLeadId = Array.isArray(data) ? data[0]?.id : data?.id;

    // Fire welcome email + SMS async — do not block the response.
    // Welcome only fires when:
    //   1. SEND_REMINDERS_SECRET is set (internal auth)
    //   2. The lead has an email OR consent_sms + phone (handled by send-welcome itself)
    if (newLeadId && process.env.SEND_REMINDERS_SECRET) {
      const host = req.headers.host || 'prattformayor2026.com';
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const welcomeUrl = `${proto}://${host}/api/send-welcome?secret=${encodeURIComponent(process.env.SEND_REMINDERS_SECRET)}`;
      // Fire-and-forget: do not await, do not block, ignore errors
      fetch(welcomeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: newLeadId }),
        keepalive: true
      }).catch(err => console.error('Welcome trigger failed', err));
    }

    return res.status(200).json({ ok: true, id: newLeadId });
  } catch (err) {
    console.error('Lead capture error', err);
    return res.status(200).json({ ok: false, reason: 'fetch_failed' });
  }
}
