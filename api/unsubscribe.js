// ============================================================
// Email unsubscribe handler
// Vercel Serverless Function (Node 20)
//
// Endpoint:
//   GET  /api/unsubscribe?email=foo@bar.com&t=HMAC_HEX
//        → verifies HMAC, marks opted_out_email=true, returns HTML confirmation
//   POST /api/unsubscribe  (form action from confirmation page)
//        → same logic, supports resubscribe via ?action=resubscribe
//
// Security:
//   The HMAC is sha256(email, UNSUBSCRIBE_HMAC_SECRET). An attacker would need
//   the secret to forge tokens for other emails. Without it, they can only
//   unsubscribe addresses they already know — but they need a valid token too.
//
// Also supports Gmail/Outlook's "one-click unsubscribe" via the
// `List-Unsubscribe-Post: List-Unsubscribe=One-Click` header
// (sent in /api/send-reminders.js).
// ============================================================

import crypto from 'node:crypto';

function makeToken(email, secret) {
  return crypto.createHmac('sha256', secret).update(email.toLowerCase().trim()).digest('hex');
}

function verifyToken(email, token, secret) {
  if (!email || !token || !secret) return false;
  const expected = makeToken(email, secret);
  // Use constant-time compare to defeat timing attacks
  try {
    return crypto.timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

async function setOptOut(email, optOut, supabaseUrl, serviceKey) {
  const url = `${supabaseUrl}/rest/v1/leads?email_normalized=eq.${encodeURIComponent(email.toLowerCase().trim())}`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
      'Prefer': 'return=representation'
    },
    body: JSON.stringify({
      opted_out_email: optOut,
      opted_out_at: optOut ? new Date().toISOString() : null
    })
  });
  if (!r.ok) {
    console.error('Opt-out patch failed', r.status, await r.text());
    return 0;
  }
  const rows = await r.json();
  return Array.isArray(rows) ? rows.length : 0;
}

function htmlPage({ title, heading, body, actionUrl, actionLabel, status }) {
  const colors = {
    success: { bg: '#F76B1C', fg: '#0A0A0A' },
    error:   { bg: '#DC2626', fg: '#FFFFFF' },
    info:    { bg: '#1a1a1a', fg: '#FFFFFF' }
  };
  const c = colors[status] || colors.info;
  return `<!doctype html><html lang="en"><head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} | Pratt for Mayor 2026</title>
<meta name="robots" content="noindex,nofollow" />
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0A0A0A;color:#F5F5F5;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{max-width:520px;width:100%;background:#1a1a1a;border:1px solid rgba(247,107,28,0.2);border-radius:12px;overflow:hidden}
  .banner{background:${c.bg};color:${c.fg};padding:28px 24px;text-align:center;font-family:Georgia,serif;font-weight:900;font-size:28px;line-height:1.1}
  .body{padding:28px 24px;color:#ccc;font-size:16px;line-height:1.55}
  .body p{margin-bottom:14px}
  .btn{display:inline-block;background:#F76B1C;color:#0A0A0A;padding:14px 28px;text-decoration:none;font-weight:800;border-radius:6px;font-size:15px;margin-top:14px;border:0;cursor:pointer;font-family:inherit}
  .btn:hover{background:#FF9145}
  .btn-secondary{background:transparent;border:1px solid #666;color:#ccc}
  .btn-secondary:hover{border-color:#F76B1C;color:#F76B1C}
  .footer{padding:18px 24px;font-size:11px;color:#666;text-align:center;line-height:1.5;border-top:1px solid rgba(247,107,28,0.1)}
  .footer a{color:#F76B1C;text-decoration:underline}
  form{margin-top:14px}
</style></head><body>
<div class="card">
  <div class="banner">${heading}</div>
  <div class="body">
    ${body}
    ${actionUrl && actionLabel ? `<form method="POST" action="${actionUrl}"><button type="submit" class="btn">${actionLabel}</button></form>` : ''}
    <p style="margin-top:18px"><a href="https://prattformayor2026.com/" class="btn btn-secondary" style="text-decoration:none;display:inline-block">Back to the campaign</a></p>
  </div>
  <div class="footer">
    Paid for by Pratt for Mayor 2026 (FPPC ID 1485940)<br>
    970 Seacoast Drive, Suite 7, Imperial Beach, CA 91932<br>
    <a href="https://mayorpratt.com/privacy-policy/">Privacy Policy</a>
  </div>
</div>
</body></html>`;
}

export default async function handler(req, res) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const SECRET = process.env.UNSUBSCRIBE_HMAC_SECRET;

  if (!SUPABASE_URL || !SERVICE_KEY || !SECRET) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(500).send(htmlPage({
      title: 'Service unavailable',
      heading: 'Service unavailable',
      body: '<p>The unsubscribe service is not currently configured. Please reply to any of our emails with "unsubscribe" and we will remove you manually within 24 hours.</p>',
      status: 'error'
    }));
  }

  // Parse query (GET) or body (POST)
  const query = req.query || {};
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch {
      // Try URL-encoded form
      try {
        const params = new URLSearchParams(body);
        body = {};
        for (const [k, v] of params) body[k] = v;
      } catch { body = {}; }
    }
  }
  body = body || {};
  const params = Object.assign({}, query, body);

  const email = (params.email || '').toString().toLowerCase().trim();
  const token = (params.t || params.token || '').toString().trim();
  const action = (params.action || 'unsubscribe').toString();

  // Validate
  if (!email) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(400).send(htmlPage({
      title: 'Missing email',
      heading: 'Invalid link',
      body: '<p>This unsubscribe link is missing required information. If you want to opt out, reply to any of our emails with "unsubscribe" and we will remove you within 24 hours.</p>',
      status: 'error'
    }));
  }

  if (!verifyToken(email, token, SECRET)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(403).send(htmlPage({
      title: 'Invalid token',
      heading: 'Invalid link',
      body: '<p>This unsubscribe link is invalid or has expired. If you want to opt out, reply to any of our emails with "unsubscribe" and we will remove you within 24 hours.</p>',
      status: 'error'
    }));
  }

  // Process the action
  if (action === 'resubscribe') {
    const count = await setOptOut(email, false, SUPABASE_URL, SERVICE_KEY);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(htmlPage({
      title: 'Resubscribed',
      heading: 'Welcome back.',
      body: `<p>You're resubscribed to Pratt for Mayor 2026 emails at <strong>${email}</strong>.</p><p>You'll continue to receive updates leading up to the June 2 election.</p>`,
      status: 'success'
    }));
  }

  // Default: unsubscribe
  const count = await setOptOut(email, true, SUPABASE_URL, SERVICE_KEY);
  const resubUrl = `/api/unsubscribe?email=${encodeURIComponent(email)}&t=${token}&action=resubscribe`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(htmlPage({
    title: 'Unsubscribed',
    heading: "You're unsubscribed.",
    body: `<p>${email} has been removed from Pratt for Mayor 2026 email updates.</p><p>You won't receive any more campaign emails. Note: this only unsubscribes you from email. If you also receive SMS reminders, reply STOP to any text from us.</p><p style="font-size:13px;color:#888;margin-top:18px">Changed your mind?</p>`,
    actionUrl: resubUrl,
    actionLabel: 'Resubscribe me',
    status: 'success'
  }));
}
