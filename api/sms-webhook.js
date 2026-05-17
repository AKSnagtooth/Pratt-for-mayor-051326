// ============================================================
// Twilio SMS webhook handler
// Vercel Serverless Function (Node 20)
//
// Twilio sends a POST here whenever someone:
//   - Replies to one of our SMS messages (STOP, HELP, or anything else)
//   - Receives our message (status callback: queued, sent, delivered, failed)
//
// Configure in Twilio:
//   Messaging Service → Integration → Incoming Messages:
//     Webhook URL: https://prattformayor2026.com/api/sms-webhook
//     Method: POST
//   Same for Status Callbacks.
//
// Twilio sends application/x-www-form-urlencoded body.
// ============================================================

const STOP_KEYWORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'];
const START_KEYWORDS = ['START', 'YES', 'UNSTOP'];
const HELP_KEYWORDS = ['HELP', 'INFO'];

function parseFormBody(body) {
  if (typeof body === 'object' && body !== null) return body;
  if (typeof body !== 'string') return {};
  const params = new URLSearchParams(body);
  const out = {};
  for (const [k, v] of params) out[k] = v;
  return out;
}

async function findLeadByPhone(phone, supabaseUrl, serviceKey) {
  // Match against the phone column. Try both as-is and normalized (digits-only).
  const digitsOnly = phone.replace(/\D/g, '');
  const url = `${supabaseUrl}/rest/v1/leads?or=(phone.eq.${encodeURIComponent(phone)},phone.eq.${encodeURIComponent(digitsOnly)},phone.eq.${encodeURIComponent('+' + digitsOnly)})&select=id,phone&limit=10`;
  const r = await fetch(url, {
    headers: {
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`
    }
  });
  if (!r.ok) return [];
  return r.json();
}

async function markOptedOut(phone, supabaseUrl, serviceKey) {
  const leads = await findLeadByPhone(phone, supabaseUrl, serviceKey);
  for (const lead of leads) {
    await fetch(`${supabaseUrl}/rest/v1/leads?id=eq.${lead.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`
      },
      body: JSON.stringify({
        opted_out_sms: true,
        opted_out_at: new Date().toISOString()
      })
    });
  }
  return leads.length;
}

async function markOptedIn(phone, supabaseUrl, serviceKey) {
  const leads = await findLeadByPhone(phone, supabaseUrl, serviceKey);
  for (const lead of leads) {
    await fetch(`${supabaseUrl}/rest/v1/leads?id=eq.${lead.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`
      },
      body: JSON.stringify({
        opted_out_sms: false,
        opted_out_at: null
      })
    });
  }
  return leads.length;
}

async function updateMessageStatus(providerId, status, supabaseUrl, serviceKey) {
  if (!providerId) return;
  const patch = { status };
  if (status === 'delivered') patch.delivered_at = new Date().toISOString();
  await fetch(`${supabaseUrl}/rest/v1/lead_messages?provider_id=eq.${providerId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`
    },
    body: JSON.stringify(patch)
  });
}

function twiML(message) {
  const xml = message
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${message}</Message></Response>`
    : `<?xml version="1.0" encoding="UTF-8"?><Response/>`;
  return xml;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).end();
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).end();
  }

  const body = parseFormBody(req.body);

  // ---------------------------------------------------------------
  // STATUS CALLBACK — Twilio reports delivery state of OUR message
  // Fields: MessageSid, MessageStatus (queued, sent, delivered, failed, etc.)
  // ---------------------------------------------------------------
  if (body.MessageStatus && body.MessageSid && !body.Body) {
    await updateMessageStatus(body.MessageSid, body.MessageStatus, SUPABASE_URL, SERVICE_KEY);
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(twiML());
  }

  // ---------------------------------------------------------------
  // INBOUND MESSAGE — user replied to our SMS
  // Fields: From (sender), To (our number), Body (their message)
  // ---------------------------------------------------------------
  const inbound = (body.Body || '').trim();
  const inboundUpper = inbound.toUpperCase();
  const from = body.From || '';

  // STOP keyword handling
  if (STOP_KEYWORDS.includes(inboundUpper)) {
    await markOptedOut(from, SUPABASE_URL, SERVICE_KEY);
    // Twilio's Messaging Service handles the auto-confirmation reply if configured,
    // but we'll also send one as a fallback (no-op if Twilio already did).
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(twiML('Pratt for Mayor 2026 FPPC#1485940: You have been unsubscribed and will not receive further messages. Reply START to resubscribe.'));
  }

  // START keyword (opt back in)
  if (START_KEYWORDS.includes(inboundUpper)) {
    await markOptedIn(from, SUPABASE_URL, SERVICE_KEY);
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(twiML('Pratt for Mayor 2026 FPPC#1485940: You are resubscribed. Mail your ballot for Spencer by 6/2. Reply STOP to opt out.'));
  }

  // HELP keyword
  if (HELP_KEYWORDS.includes(inboundUpper)) {
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(twiML('Pratt for Mayor 2026 FPPC#1485940: Mail your ballot for Spencer by 6/2 (8 PM). Info: prattformayor2026.com. Reply STOP to opt out. Msg & data rates may apply.'));
  }

  // Anything else: log & no auto-reply
  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send(twiML());
}
