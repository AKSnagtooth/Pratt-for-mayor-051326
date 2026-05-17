// ============================================================
// Welcome email + SMS on signup
// Vercel Serverless Function (Node 20)
//
// Triggered async from /api/lead.js after a successful insert.
// Sends:
//   1. Welcome email via Resend (if lead has email)
//   2. Welcome SMS via Twilio (if lead has consent_sms + phone + Twilio configured)
// Logs both attempts to public.lead_messages with message_key='welcome'.
//
// Internal auth: caller must pass ?secret= or Authorization: Bearer
// matching SEND_REMINDERS_SECRET (reused — no new env var needed).
// ============================================================

import crypto from 'node:crypto';

// =============================================================
// Welcome templates
// =============================================================
const WELCOME_SMS = "Pratt for Mayor 2026: You're in. Watch for ballot reminders before 6/2. Paid for by Pratt for Mayor 2026 FPPC#1485940. Reply STOP to opt out, HELP for help.";

const WELCOME_EMAIL = {
  subject: "You're in. Save LA.",
  preheader: "Welcome to the Pratt for Mayor 2026 movement.",
  heading: "You're in.",
  body: '<p>Welcome to the movement.</p><p>Your ballot is in your mailbox right now. <strong>Mail it for Spencer Pratt by June 2 at 8 PM.</strong> Postage is prepaid. Drop in any USPS mailbox.</p><p>We\'ll send a few reminders leading up to the election. No spam.</p>',
  ctaText: "Read Spencer's case for LA",
  ctaUrl: 'https://prattformayor2026.com/save-la?utm_source=email&utm_medium=lifecycle&utm_campaign=welcome'
};

// =============================================================
// HMAC signed unsubscribe URL (reuse from send-reminders pattern)
// =============================================================
function unsubscribeUrl(email) {
  const secret = process.env.UNSUBSCRIBE_HMAC_SECRET;
  if (!secret) return 'https://prattformayor2026.com/';
  const e = (email || '').toLowerCase().trim();
  const t = crypto.createHmac('sha256', secret).update(e).digest('hex');
  return `https://prattformayor2026.com/api/unsubscribe?email=${encodeURIComponent(e)}&t=${t}`;
}

// =============================================================
// Auth check
// =============================================================
function isAuthorized(req) {
  const secret = process.env.SEND_REMINDERS_SECRET;
  if (!secret) return false;
  if (req.query?.secret === secret) return true;
  if (req.headers.authorization === `Bearer ${secret}`) return true;
  return false;
}

// =============================================================
// Fetch a lead by ID
// =============================================================
async function fetchLead(leadId, supabaseUrl, serviceKey) {
  const url = `${supabaseUrl}/rest/v1/leads?id=eq.${leadId}&select=id,email,phone,first_name,consent_sms,opted_out_sms,opted_out_email&limit=1`;
  const r = await fetch(url, {
    headers: {
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`
    }
  });
  if (!r.ok) return null;
  const rows = await r.json();
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

// =============================================================
// Log message attempt to lead_messages
// =============================================================
async function logMessage(record, supabaseUrl, serviceKey) {
  try {
    await fetch(`${supabaseUrl}/rest/v1/lead_messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Prefer': 'return=minimal,resolution=ignore-duplicates'
      },
      body: JSON.stringify(record)
    });
  } catch (e) {
    console.error('logMessage failed', e);
  }
}

// =============================================================
// Twilio
// =============================================================
async function sendSms(to, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER;
  const msid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  if (!sid || !token || (!from && !msid)) {
    return { ok: false, error: 'twilio_not_configured' };
  }
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  const params = new URLSearchParams();
  params.append('To', to);
  params.append('Body', body);
  if (msid) params.append('MessagingServiceSid', msid);
  else params.append('From', from);

  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });
  const json = await r.json();
  if (!r.ok) return { ok: false, error: json.message || `http_${r.status}`, raw: json };
  return { ok: true, providerId: json.sid };
}

// =============================================================
// Resend
// =============================================================
async function sendEmail(to, firstName) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) return { ok: false, error: 'resend_not_configured' };

  const unsubUrl = unsubscribeUrl(to);
  const greeting = firstName ? `<p>Hi ${firstName},</p>` : '';

  const fullHtml = `<!doctype html><html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#0A0A0A; color:#F5F5F5; margin:0; padding:0;">
<span style="display:none; max-height:0; overflow:hidden;">${WELCOME_EMAIL.preheader}</span>
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0A0A0A;">
  <tr><td align="center" style="padding:40px 20px;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
      <tr><td style="padding:20px; background:#F76B1C; color:#0A0A0A; font-weight:900; font-size:14px; letter-spacing:0.1em; text-transform:uppercase;">Pratt for Mayor 2026</td></tr>
      <tr><td style="padding:32px 24px; background:#1a1a1a;">
        <h1 style="font-family: Georgia, serif; font-size:36px; font-weight:900; color:#fff; margin:0 0 16px 0; line-height:1.1;">${WELCOME_EMAIL.heading}</h1>
        ${greeting}
        <div style="color:#ccc; font-size:16px; line-height:1.55;">${WELCOME_EMAIL.body}</div>
        <p style="margin:28px 0 8px 0;"><a href="${WELCOME_EMAIL.ctaUrl}" style="display:inline-block; background:#F76B1C; color:#0A0A0A; padding:14px 28px; text-decoration:none; font-weight:800; border-radius:6px; font-size:15px;">${WELCOME_EMAIL.ctaText}</a></p>
      </td></tr>
      <tr><td style="padding:24px; background:#0A0A0A; font-size:11px; line-height:1.5; color:#666; text-align:center;">
        Paid for by Pratt for Mayor 2026 (FPPC ID 1485940)<br>
        970 Seacoast Drive, Suite 7, Imperial Beach, CA 91932<br><br>
        You're receiving this because you signed up at prattformayor2026.com.<br>
        <a href="${unsubUrl}" style="color:#F76B1C;">Unsubscribe</a> &nbsp;·&nbsp;
        <a href="https://mayorpratt.com/privacy-policy/" style="color:#F76B1C;">Privacy Policy</a>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: WELCOME_EMAIL.subject,
      html: fullHtml,
      headers: {
        'List-Unsubscribe': `<${unsubUrl}>, <mailto:unsubscribe@prattformayor2026.com?subject=Unsubscribe>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
      }
    })
  });
  const json = await r.json();
  if (!r.ok) return { ok: false, error: json.message || `http_${r.status}`, raw: json };
  return { ok: true, providerId: json.id };
}

// =============================================================
// Main handler
// =============================================================
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, reason: 'method_not_allowed' });
  }
  if (!isAuthorized(req)) {
    return res.status(401).json({ ok: false, reason: 'unauthorized' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ ok: false, reason: 'supabase_not_configured' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const leadId = body.lead_id || req.query?.lead_id;
  if (!leadId) {
    return res.status(400).json({ ok: false, reason: 'missing_lead_id' });
  }

  const lead = await fetchLead(leadId, SUPABASE_URL, SERVICE_KEY);
  if (!lead) {
    return res.status(404).json({ ok: false, reason: 'lead_not_found' });
  }

  const result = { lead_id: leadId, email: null, sms: null };

  // ---------- EMAIL ----------
  if (lead.email && !lead.opted_out_email) {
    const emailResult = await sendEmail(lead.email, lead.first_name);
    result.email = emailResult;
    await logMessage({
      lead_id: lead.id,
      channel: 'email',
      message_key: 'welcome',
      recipient: lead.email,
      status: emailResult.ok ? 'sent' : 'failed',
      provider_id: emailResult.providerId || null,
      error_message: emailResult.error || null,
      sent_at: emailResult.ok ? new Date().toISOString() : null,
      body: `[welcome email] subject=${WELCOME_EMAIL.subject}`
    }, SUPABASE_URL, SERVICE_KEY);
  } else {
    result.email = { ok: false, skipped: true, reason: lead.email ? 'opted_out' : 'no_email' };
  }

  // ---------- SMS ----------
  if (lead.phone && lead.consent_sms && !lead.opted_out_sms) {
    const smsResult = await sendSms(lead.phone, WELCOME_SMS);
    result.sms = smsResult;
    await logMessage({
      lead_id: lead.id,
      channel: 'sms',
      message_key: 'welcome',
      recipient: lead.phone,
      status: smsResult.ok ? 'sent' : 'failed',
      provider_id: smsResult.providerId || null,
      error_message: smsResult.error || null,
      sent_at: smsResult.ok ? new Date().toISOString() : null,
      body: WELCOME_SMS
    }, SUPABASE_URL, SERVICE_KEY);
  } else {
    let reason = 'no_phone';
    if (lead.phone && !lead.consent_sms) reason = 'no_consent';
    else if (lead.phone && lead.opted_out_sms) reason = 'opted_out';
    result.sms = { ok: false, skipped: true, reason };
  }

  return res.status(200).json({ ok: true, ...result });
}
