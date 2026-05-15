// ============================================================
// Meta Conversions API (CAPI) forwarder
// Vercel Serverless Function — runtime: nodejs20 (native fetch)
// ============================================================
// Receives POSTs from the client-side trackEvent() helper and
// forwards a server-side event to Meta's Graph API. The shared
// event_id de-duplicates with the browser Pixel event.
//
// Required env vars (set in Vercel project settings):
//   META_PIXEL_ID    e.g. 1234567890123456
//   META_CAPI_TOKEN  long-lived access token from Events Manager
// Optional:
//   META_TEST_EVENT_CODE  set to "TEST12345" while validating in
//                         Events Manager > Test events tab.
// ============================================================

import crypto from 'node:crypto';

const META_API_VERSION = 'v19.0';

// Hash PII per Meta spec: lowercased, trimmed, SHA-256 hex
function sha256(input) {
  if (input === null || input === undefined) return undefined;
  const v = String(input).trim().toLowerCase();
  if (!v) return undefined;
  return crypto.createHash('sha256').update(v).digest('hex');
}

// Strip protocol/port from forwarded IP
function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (!fwd) return req.socket?.remoteAddress;
  return String(fwd).split(',')[0].trim();
}

export default async function handler(req, res) {
  // CORS — same-origin only for production, allow OPTIONS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const PIXEL_ID = process.env.META_PIXEL_ID;
  const TOKEN = process.env.META_CAPI_TOKEN;
  const TEST_CODE = process.env.META_TEST_EVENT_CODE;

  if (!PIXEL_ID || !TOKEN) {
    // Fail open so the client Pixel still works even if CAPI is misconfigured
    return res.status(200).json({ ok: false, reason: 'capi_not_configured' });
  }

  let body = req.body;
  // Vercel parses JSON automatically when Content-Type is set,
  // but be defensive in case of raw string bodies.
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const {
    event_name,
    event_id,
    event_source_url,
    custom_data = {},
    user_data: clientUserData = {}
  } = body;

  if (!event_name) {
    return res.status(400).json({ error: 'event_name required' });
  }

  // Build user_data with hashed PII + connection signals
  const ip = getClientIp(req);
  const ua = req.headers['user-agent'];
  const fbpCookie = (req.headers.cookie || '').match(/(?:^|;\s*)_fbp=([^;]+)/)?.[1];
  const fbcCookie = (req.headers.cookie || '').match(/(?:^|;\s*)_fbc=([^;]+)/)?.[1];

  const user_data = {
    client_ip_address: ip,
    client_user_agent: ua,
    fbp: fbpCookie,
    fbc: fbcCookie,
    em: clientUserData.email ? [sha256(clientUserData.email)] : undefined,
    ph: clientUserData.phone ? [sha256(clientUserData.phone.replace(/\D/g, ''))] : undefined,
    zp: clientUserData.zip ? [sha256(clientUserData.zip)] : undefined,
    ct: clientUserData.city ? [sha256(clientUserData.city)] : undefined,
    st: clientUserData.state ? [sha256(clientUserData.state)] : undefined,
    country: clientUserData.country ? [sha256(clientUserData.country)] : undefined,
  };

  // Remove undefined keys so Meta doesn't reject
  Object.keys(user_data).forEach(k => user_data[k] === undefined && delete user_data[k]);

  const event = {
    event_name,
    event_time: Math.floor(Date.now() / 1000),
    event_id, // CRITICAL: same value the browser Pixel sent for dedup
    event_source_url: event_source_url || req.headers.referer,
    action_source: 'website',
    user_data,
    custom_data
  };

  const payload = { data: [event] };
  if (TEST_CODE) payload.test_event_code = TEST_CODE;

  const url = `https://graph.facebook.com/${META_API_VERSION}/${PIXEL_ID}/events?access_token=${encodeURIComponent(TOKEN)}`;

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    if (!r.ok) {
      console.error('CAPI error', r.status, json);
      return res.status(200).json({ ok: false, status: r.status, meta: json });
    }
    return res.status(200).json({ ok: true, meta: json });
  } catch (err) {
    console.error('CAPI fetch failed', err);
    return res.status(200).json({ ok: false, reason: 'fetch_failed' });
  }
}
