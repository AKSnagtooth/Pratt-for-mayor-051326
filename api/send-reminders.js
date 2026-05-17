// ============================================================
// Scheduled SMS + Email reminders
// Vercel Serverless Function (Node 20)
//
// Triggered by Vercel Cron once daily at 10:00 AM PT.
// Determines today's reminder (if any) and sends to all eligible leads.
// Logs every send to public.lead_messages with dedup index.
//
// Required env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   TWILIO_ACCOUNT_SID
//   TWILIO_AUTH_TOKEN
//   TWILIO_PHONE_NUMBER          E.164 format (+12135550100)
//   TWILIO_MESSAGING_SERVICE_SID Optional but recommended for political SMS
//   RESEND_API_KEY
//   RESEND_FROM_EMAIL            e.g. "Spencer Pratt <reminders@prattformayor2026.com>"
//
// Auth:
//   Vercel Cron sends header "x-vercel-cron: 1" automatically. We trust that header.
//   For manual testing: set SEND_REMINDERS_SECRET and pass ?secret=... in the URL.
// ============================================================

import crypto from 'node:crypto';

function unsubscribeUrl(email) {
  const secret = process.env.UNSUBSCRIBE_HMAC_SECRET;
  if (!secret) return 'https://prattformayor2026.com/';
  const e = (email || '').toLowerCase().trim();
  const t = crypto.createHmac('sha256', secret).update(e).digest('hex');
  return `https://prattformayor2026.com/api/unsubscribe?email=${encodeURIComponent(e)}&t=${t}`;
}

// =============================================================
// SCHEDULE: which message to send on which date
// Dates are in America/Los_Angeles timezone (campaign timezone).
// =============================================================
const SCHEDULE = {
  '2026-05-20': { key: 'initial',      channels: ['sms', 'email'] },
  '2026-05-26': { key: 'week',         channels: ['sms', 'email'] },
  '2026-05-30': { key: 'three_days',   channels: ['sms'] },
  '2026-06-01': { key: 'tomorrow',     channels: ['sms', 'email'] },
  '2026-06-02': { key: 'election_day', channels: ['sms', 'email'] }
};

// =============================================================
// MESSAGE TEMPLATES
// SMS must include campaign identity + STOP/HELP for TCPA compliance.
// =============================================================
const TEMPLATES = {
  initial: {
    sms: 'Pratt for Mayor 2026: Your LA ballot is in your mailbox. Mail it for Spencer by 6/2 (8 PM). Postage paid, drop in any USPS mailbox. Vote Pratt: https://prattformayor2026.com Reply STOP to opt out, HELP for help.',
    email: {
      subject: 'Your ballot is in your mailbox',
      preheader: 'Mail it for Spencer Pratt by June 2.',
      heading: 'Your ballot is here.',
      body: '<p>Your official LA County ballot arrived in your mailbox in early May.</p><p><strong>Mail it for Spencer Pratt by June 2 at 8 PM.</strong> Postage is prepaid. Drop it in any USPS mailbox.</p>',
      ctaText: 'How to mail your ballot',
      ctaUrl: 'https://prattformayor2026.com/?utm_source=email&utm_medium=lifecycle&utm_campaign=reminder_initial'
    }
  },
  week: {
    sms: 'Pratt for Mayor 2026: One week left. Mail your ballot for Spencer Pratt by 6/2. Drop in any USPS mailbox, postage paid. https://prattformayor2026.com Reply STOP.',
    email: {
      subject: 'One week to mail your ballot',
      preheader: 'Seven days until June 2.',
      heading: 'Seven days left.',
      body: '<p>Election day is one week away.</p><p>Spencer is polling 2nd. Bass approval is 31%. The runoff is in reach if you mail your ballot.</p><p><strong>Mail your ballot for Spencer Pratt by June 2 at 8 PM.</strong> Drop in any USPS mailbox.</p>',
      ctaText: 'Mail my ballot today',
      ctaUrl: 'https://prattformayor2026.com/?utm_source=email&utm_medium=lifecycle&utm_campaign=reminder_week'
    }
  },
  three_days: {
    sms: 'Pratt for Mayor 2026: 3 days. Have you mailed your ballot? Spencer Pratt for Mayor. Drop in any USPS mailbox by 6/2 (8 PM). Reply STOP.',
    email: null
  },
  tomorrow: {
    sms: 'Pratt for Mayor 2026: TOMORROW is election day. Mail your Spencer Pratt ballot by 8 PM, or vote in person at any LA County Vote Center. Find one: https://locator.lavote.gov/locations/vc Reply STOP.',
    email: {
      subject: 'Tomorrow: Election Day',
      preheader: 'Mail or drop your ballot by 8 PM tomorrow.',
      heading: 'Tomorrow.',
      body: '<p>June 2 is election day.</p><p>If you haven\'t mailed your ballot yet, your options:</p><ol><li><strong>Drop it in any USPS mailbox</strong> (must be postmarked by tomorrow)</li><li><strong>Vote in person</strong> at any LA County Vote Center, open 7 AM to 8 PM</li></ol><p>Vote Spencer Pratt for Mayor of LA.</p>',
      ctaText: 'Find a Vote Center',
      ctaUrl: 'https://locator.lavote.gov/locations/vc?id=4338&culture=en'
    }
  },
  election_day: {
    sms: 'Pratt for Mayor 2026: TODAY is Election Day. Polls close 8 PM. Vote Spencer Pratt. Vote in person: https://locator.lavote.gov/locations/vc Reply STOP.',
    email: {
      subject: 'Today: Polls close 8 PM',
      preheader: 'Today is election day. Vote Spencer Pratt.',
      heading: 'Today.',
      body: '<p>Polls close at 8 PM tonight.</p><p>If you haven\'t voted: <strong>find your nearest LA County Vote Center.</strong> Open 7 AM to 8 PM.</p><p>Vote Spencer Pratt for Mayor of Los Angeles.</p>',
      ctaText: 'Find a Vote Center',
      ctaUrl: 'https://locator.lavote.gov/locations/vc?id=4338&culture=en'
    }
  }
};

// =============================================================
// Get today's date in America/Los_Angeles (YYYY-MM-DD)
// =============================================================
function getTodayLA() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  return fmt.format(new Date()); // already YYYY-MM-DD in en-CA
}

// =============================================================
// Auth check: Vercel Cron sets x-vercel-cron header
// Manual trigger: ?secret=... matches SEND_REMINDERS_SECRET
// =============================================================
function isAuthorized(req) {
  if (req.headers['x-vercel-cron']) return true;
  const secret = process.env.SEND_REMINDERS_SECRET;
  if (secret && req.query?.secret === secret) return true;
  // Also allow Bearer token in Authorization header
  if (secret && req.headers.authorization === `Bearer ${secret}`) return true;
  return false;
}

// =============================================================
// Fetch eligible leads for a channel
// =============================================================
async function fetchEligibleLeads(channel, messageKey, supabaseUrl, serviceKey) {
  // Build the filter:
  //   - channel='sms':   consent_sms = true AND phone IS NOT NULL AND opted_out_sms = false
  //   - channel='email': email IS NOT NULL AND opted_out_email = false
  // Exclude leads that already received this message_key on this channel (via lead_messages join).
  // PostgREST doesn't easily support anti-joins, so we use rpc OR a separate exclusion query.
  // Simpler approach: fetch all eligible leads, then check lead_messages for each batch.

  let url;
  if (channel === 'sms') {
    url = `${supabaseUrl}/rest/v1/leads?select=id,email,phone,first_name&consent_sms=eq.true&phone=not.is.null&opted_out_sms=eq.false`;
  } else {
    url = `${supabaseUrl}/rest/v1/leads?select=id,email,phone,first_name&email=not.is.null&opted_out_email=eq.false`;
  }

  const r = await fetch(url, {
    headers: {
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
      'Range': '0-9999' // up to 10K leads per channel
    }
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Supabase fetch leads failed: ${r.status} ${text}`);
  }
  return r.json();
}

// =============================================================
// Check if a message has already been sent (dedup)
// =============================================================
async function alreadySent(leadId, channel, messageKey, supabaseUrl, serviceKey) {
  const url = `${supabaseUrl}/rest/v1/lead_messages?lead_id=eq.${leadId}&channel=eq.${channel}&message_key=eq.${messageKey}&select=id`;
  const r = await fetch(url, {
    headers: {
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`
    }
  });
  if (!r.ok) return false; // fail-open: don't block on a dedup-check error
  const rows = await r.json();
  return Array.isArray(rows) && rows.length > 0;
}

// =============================================================
// Log a message attempt (insert into lead_messages)
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
// Send via Twilio
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
// Send via Resend
// =============================================================
async function sendEmail(to, subject, preheader, heading, bodyHtml, ctaText, ctaUrl) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) return { ok: false, error: 'resend_not_configured' };

  const unsubUrl = unsubscribeUrl(to);

  const fullHtml = `<!doctype html><html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#0A0A0A; color:#F5F5F5; margin:0; padding:0;">
<span style="display:none; max-height:0; overflow:hidden;">${preheader}</span>
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0A0A0A;">
  <tr><td align="center" style="padding:40px 20px;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
      <tr><td style="padding:20px; background:#F76B1C; color:#0A0A0A; font-weight:900; font-size:14px; letter-spacing:0.1em; text-transform:uppercase;">Pratt for Mayor 2026</td></tr>
      <tr><td style="padding:32px 24px; background:#1a1a1a;">
        <h1 style="font-family: Georgia, serif; font-size:32px; font-weight:900; color:#fff; margin:0 0 16px 0; line-height:1.1;">${heading}</h1>
        <div style="color:#ccc; font-size:16px; line-height:1.55;">${bodyHtml}</div>
        ${ctaText && ctaUrl ? `<p style="margin:28px 0 8px 0;"><a href="${ctaUrl}" style="display:inline-block; background:#F76B1C; color:#0A0A0A; padding:14px 28px; text-decoration:none; font-weight:800; border-radius:6px; font-size:15px;">${ctaText}</a></p>` : ''}
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
      subject,
      html: fullHtml,
      headers: {
        // One-click unsubscribe for Gmail/Outlook
        // (RFC 8058: List-Unsubscribe-Post enables one-click via POST)
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
  if (!isAuthorized(req)) {
    return res.status(401).json({ ok: false, reason: 'unauthorized' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ ok: false, reason: 'supabase_not_configured' });
  }

  // Dry-run mode: ?dry=1 returns plan without sending
  const dry = req.query?.dry === '1' || req.query?.dry === 'true';
  // Force-send mode: ?force=KEY overrides the date check (manual test trigger)
  const force = req.query?.force;

  const today = getTodayLA();
  const todayMessage = force ? { key: force, channels: ['sms', 'email'] } : SCHEDULE[today];

  if (!todayMessage) {
    return res.status(200).json({ ok: true, today, message: null, info: 'no_send_today' });
  }

  const tpl = TEMPLATES[todayMessage.key];
  if (!tpl) {
    return res.status(200).json({ ok: false, reason: 'no_template', key: todayMessage.key });
  }

  const summary = { today, message_key: todayMessage.key, channels: {}, errors: [] };

  for (const channel of todayMessage.channels) {
    // Skip channel if its template body isn't present
    if (channel === 'sms' && !tpl.sms) continue;
    if (channel === 'email' && !tpl.email) continue;

    const leads = await fetchEligibleLeads(channel, todayMessage.key, SUPABASE_URL, SERVICE_KEY);
    let sentCount = 0, skipCount = 0, failCount = 0;

    for (const lead of leads) {
      // Dedup check
      if (await alreadySent(lead.id, channel, todayMessage.key, SUPABASE_URL, SERVICE_KEY)) {
        skipCount++;
        continue;
      }

      if (dry) {
        sentCount++;
        continue;
      }

      let result;
      const recipient = channel === 'sms' ? lead.phone : lead.email;
      const body = channel === 'sms' ? tpl.sms : null;

      if (channel === 'sms') {
        result = await sendSms(recipient, tpl.sms);
      } else {
        result = await sendEmail(
          recipient,
          tpl.email.subject,
          tpl.email.preheader,
          tpl.email.heading,
          tpl.email.body,
          tpl.email.ctaText,
          tpl.email.ctaUrl
        );
      }

      await logMessage({
        lead_id: lead.id,
        channel,
        message_key: todayMessage.key,
        recipient,
        status: result.ok ? 'sent' : 'failed',
        provider_id: result.providerId || null,
        error_message: result.error || null,
        sent_at: result.ok ? new Date().toISOString() : null,
        body: body || `[email] subject=${tpl.email?.subject}`
      }, SUPABASE_URL, SERVICE_KEY);

      if (result.ok) sentCount++;
      else { failCount++; summary.errors.push({ leadId: lead.id, error: result.error }); }
    }

    summary.channels[channel] = { eligible: leads.length, sent: sentCount, skipped: skipCount, failed: failCount };
  }

  return res.status(200).json({ ok: true, ...summary });
}
