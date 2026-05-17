# Meta Pixel + Conversions API — Setup & Deployment

This installs **both** the browser Pixel and Conversions API (CAPI) on the three landing pages, with shared `event_id` deduplication so Meta counts each conversion exactly once.

## What got installed

| File | Change |
|---|---|
| `index.html` | Pixel base code in `<head>` + `window.trackEvent()` helper. `findDropBoxes()` and `submitSignup()` now fire deduped events. |
| `ballot.html` | Same as above for `BallotFinder` and `BallotReminder` events. |
| `save-la.html` | Same + auto-fires `ViewContent` on page load (persuasion-page funnel signal). |
| `api/track.js` | Vercel Serverless Function (Node 20) that forwards events to Meta Graph API with hashed PII. |
| `scripts/inject-pixel-id.mjs` | Build step that replaces `__META_PIXEL_ID__` placeholder in HTML with the env var at deploy time. |
| `package.json` | `vercel-build` script wiring. |
| `vercel.json` | Adds `buildCommand`, declares `api/track.js` as a Node 20 function, and no-store cache on `/api/*`. |

## Step 1 — Set environment variables in Vercel

The Pixel ID `4456287721319223` is **already hardcoded** in the three HTML files. The browser Pixel fires the moment you redeploy — no env vars required for client-side tracking.

Add the following in Vercel dashboard → `pratt-landing` → **Settings → Environment Variables** (Production + Preview):

### Meta Conversions API (server-side Pixel half)

| Name | Value | Where to get it |
|---|---|---|
| `META_PIXEL_ID` | `4456287721319223` | Set this so `/api/track.js` knows where to send events. |
| `META_CAPI_TOKEN` | Long-lived access token | Meta Events Manager → your Pixel → **Settings** tab → **Conversions API → Generate access token**. Save it somewhere secure — Meta only shows it once. |
| `META_TEST_EVENT_CODE` | *(optional, only while validating)* e.g. `TEST12345` | Events Manager → your Pixel → **Test events** tab. Use during QA, then **delete this var** before launching ads. |

> Without `META_CAPI_TOKEN`, the `/api/track` endpoint returns `{ok:false, reason:"capi_not_configured"}` — the browser Pixel still works, but you lose CAPI's iOS conversion recovery (typically a 10–25% lift on attributed Leads).

### Supabase (lead capture)

| Name | Value | Where to get it |
|---|---|---|
| `SUPABASE_URL` | `https://eqppnblxyxmslhgxiror.supabase.co` | Snagtooth org → `pratt-campaign` project → Settings → API → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Long JWT starting with `eyJ...` | Same Settings → API page → "Project API keys" section → copy the **`service_role`** key (has a red "secret" badge). **Never put this in client code.** |

> Without these, `/api/lead` returns `{ok:false, reason:"supabase_not_configured"}` — Pixel tracking still works, but signups are NOT captured. Get this set before turning on paid traffic.

### Cloudflare Turnstile (captcha — bot/spam protection)

| Name | Value | Where to get it |
|---|---|---|
| `TURNSTILE_SECRET_KEY` | Secret key from Cloudflare Turnstile dashboard | https://dash.cloudflare.com/?to=/:account/turnstile → Add widget → copy the **Secret Key** |
| `RATE_LIMIT_PER_HOUR` | *(optional)* number, default `5` | Max number of leads accepted from a single IP per hour |

**Plus a one-time HTML edit:** the public Turnstile **Site Key** must replace the placeholder `__TURNSTILE_SITE_KEY__` in all 3 HTML files. Run this in your terminal (replace `YOUR_SITE_KEY` with the actual key):

```bash
cd "/Users/aleksanderkocev/Snagtooth Meta Ads/Spencer Pratt/landing-pages"
sed -i '' 's/__TURNSTILE_SITE_KEY__/YOUR_SITE_KEY/g' index.html ballot.html save-la.html
git add -A && git commit -m "Add Turnstile site key" && git push
```

**Step-by-step Cloudflare Turnstile setup:**

1. Go to https://dash.cloudflare.com/?to=/:account/turnstile (free, no card required)
2. Click **Add widget**
3. Widget name: `Pratt Landing Pages`
4. Hostnames: `prattformayor2026.com`
5. Widget mode: **Managed** (lets Cloudflare decide when to challenge — invisible to most users)
6. Click **Create**
7. Copy both keys:
   - **Site Key** (public) → use in `sed` command above
   - **Secret Key** (private) → set as `TURNSTILE_SECRET_KEY` env var in Vercel
8. Redeploy via `vercel --prod` or `git push` (auto-deploy)

**Graceful degradation:** If `TURNSTILE_SECRET_KEY` is not set in Vercel, the captcha verification is skipped — the form still works. This means you can deploy this code TODAY and add Turnstile WHEN you have the keys.

> Without Turnstile, the form is protected only by honeypot fields. ~80% of bots blocked. With Turnstile: ~99%.

### Twilio (SMS reminders)

| Name | Value | Where to get it |
|---|---|---|
| `TWILIO_ACCOUNT_SID` | Starts with `AC...` | Twilio console homepage |
| `TWILIO_AUTH_TOKEN` | (secret) | Same homepage, "Auth Token" field |
| `TWILIO_PHONE_NUMBER` | E.164 like `+12135550100` | Twilio → Phone Numbers → Buy a number (US local, LA area code) |
| `TWILIO_MESSAGING_SERVICE_SID` | Starts with `MG...` | Twilio → Messaging → Services → Create Messaging Service. Required for political SMS A2P 10DLC. |
| `SEND_REMINDERS_SECRET` | Generate a long random string yourself | Used for manual cron triggers via `?secret=...` |

A2P 10DLC registration is REQUIRED for US political SMS. Without it, your messages will be blocked by carriers.

Walk-through:

1. Sign up: https://www.twilio.com/try-twilio
2. Buy a number: Phone Numbers → Buy a Number. Pick LA area code (213, 310, 323, 424, 818). Cost: ~$1.15/month.
3. Create a Messaging Service: Console → Messaging → Services → Create Messaging Service. Name "Pratt for Mayor 2026". Use case "Notifications". Add your phone number as a sender.
4. A2P 10DLC Brand registration: Messaging → Regulatory Compliance → A2P 10DLC → Brand Registration. Use FPPC ID 1485940 as tax ID equivalent (mark as Political Committee). Verification takes 1-3 business days.
5. A2P 10DLC Campaign registration: Same section → Campaign Use Case → Political. Description: "SMS reminders to registered LA County voters who opted in at prattformayor2026.com for the June 2, 2026 mayoral primary election." Sample messages: paste 2-3 templates from `/api/send-reminders.js`. Opt-in process: "User submits form on prattformayor2026.com with explicit consent checkbox." Opt-out keywords: STOP, UNSUBSCRIBE, QUIT, END, CANCEL. Help: HELP, INFO.
6. Configure Messaging Service webhook: Messaging Service → Integration → "Incoming Messages" webhook. URL: `https://prattformayor2026.com/api/sms-webhook`. Method POST. Same URL for "Status Callback" (delivery tracking).
7. Copy the credentials and add the 5 Twilio env vars to Vercel.

> Timeline: Brand verification + campaign approval = 1-7 business days for political. Start TODAY if you want SMS live by the first scheduled send (May 20).

### Resend (Email reminders)

| Name | Value | Where to get it |
|---|---|---|
| `RESEND_API_KEY` | Starts with `re_...` | https://resend.com → API Keys |
| `RESEND_FROM_EMAIL` | `Spencer Pratt <reminders@prattformayor2026.com>` | Must be a verified domain in Resend |

Walk-through:

1. Sign up: https://resend.com/signup (free tier = 3,000 emails/month).
2. Add domain: Domains → Add Domain → `prattformayor2026.com`.
3. Add DNS records Resend gives you (4 records: SPF, DKIM x2, MX) in Vercel → Settings → Domains → prattformayor2026.com → DNS Records.
4. Pro plan ($20/mo) if you expect >3K emails/month. With 5,000 leads × 4 emails = 20,000, you need Pro.
5. Create API key: API Keys → Create → name "Pratt Campaign", permission "Sending access".
6. Copy the key and set `RESEND_API_KEY` in Vercel.

### Cron schedule (already configured in vercel.json)

A single daily cron runs at 17:00 UTC = 10:00 AM PDT:
```json
"crons": [
  { "path": "/api/send-reminders", "schedule": "0 17 * * *" }
]
```

The function self-determines which message to send based on today's date (PT):

| Date (PT) | Message key | Channels |
|---|---|---|
| 2026-05-20 (Tue) | `initial` | SMS + Email |
| 2026-05-26 (Mon) | `week` | SMS + Email |
| 2026-05-30 (Fri) | `three_days` | SMS only |
| 2026-06-01 (Mon) | `tomorrow` | SMS + Email |
| 2026-06-02 (Tue) | `election_day` | SMS + Email |

On any other date the function returns `{ ok: true, info: 'no_send_today' }` and does nothing.

### Test the reminder system before May 20

After all env vars are set, manually trigger sends:

```bash
# Dry-run (no actual sends, just shows what WOULD be sent)
curl "https://prattformayor2026.com/api/send-reminders?secret=YOUR_SECRET&dry=1&force=initial"

# Real send to all eligible leads, FORCED to use the 'initial' template
curl "https://prattformayor2026.com/api/send-reminders?secret=YOUR_SECRET&force=initial"

# What the daily cron will do today (no force, uses today's date)
curl "https://prattformayor2026.com/api/send-reminders?secret=YOUR_SECRET"
```

Recommended pre-launch test: Sign yourself up at prattformayor2026.com (opt in to SMS + email), then run the dry-run + force commands to verify delivery to your own phone/email.

### Monitoring queries (Supabase SQL editor)

```sql
-- Today's sends by status
SELECT message_key, channel, status, count(*)
FROM lead_messages
WHERE created_at >= now() - interval '24 hours'
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;

-- Failures
SELECT id, lead_id, channel, message_key, recipient, error_message, created_at
FROM lead_messages
WHERE status = 'failed'
ORDER BY created_at DESC
LIMIT 50;

-- Opt-out count
SELECT count(*) FILTER (WHERE opted_out_sms) as sms_optouts,
       count(*) FILTER (WHERE opted_out_email) as email_optouts,
       count(*) as total_leads
FROM leads;
```

## Step 2 — Redeploy

From the `landing-pages/` folder on your local machine:

```bash
cd "/Users/aleksanderkocev/Snagtooth Meta Ads/Spencer Pratt/landing-pages"
vercel --prod
```

Vercel will run `npm run vercel-build`, which runs `scripts/inject-pixel-id.mjs`, which swaps `__META_PIXEL_ID__` into the deployed HTML.

## Step 3 — Verify in Events Manager

1. Open the live site in an incognito window: `https://pratt-landing.vercel.app/` (or whatever subdomain after the cutover to `prattformayor2026.com`).
2. Right-click → View Source → search for `4456287721319223`. Should appear in the Pixel base code.
3. Go to **Meta Events Manager → Test events** tab → enter the live URL. You should see:
   - `PageView` (Browser + Server, deduplicated)
   - Trigger the ballot finder or signup form → see `Lead` event with matching `event_id` across Browser + Server.
4. Check the **Overview** tab → **Event Match Quality**. Server events with hashed email/zip should show EMQ ≥ 6.0.

## Step 4 — Production checklist (before turning on paid)

- [ ] Pixel ID populated in all three HTML files (View Source check).
- [ ] CAPI token set in Vercel env vars.
- [ ] Test event code **removed** from env vars.
- [ ] In Events Manager, set **Lead** as the optimization event for Ad Set ad delivery.
- [ ] (Recommended) Add the **same Pixel** to `mayorpratt.com` if the main site is also collecting signups — gives one unified audience pool.
- [ ] Set up **Custom Audiences** in Events Manager:
  - All-Site Visitors (180 days)
  - Lead — Submitted (180 days)
  - SaveLA Page Visitors (180 days) — for sequencing
- [ ] Build **Lookalikes** off the Lead audience once you hit ~500 leads.

## Event taxonomy (what fires where)

| Event | Page | When | Custom params |
|---|---|---|---|
| `PageView` | all 3 | Page load | — |
| `ViewContent` | `save-la.html` | Page load (auto) | `content_name: SaveLA`, `content_category: persuasion` |
| `Lead` | `index.html` | Ballot finder submitted | `content_name: BallotFinder`, `zip` |
| `Lead` | `index.html` | Email signup submitted | `content_name: EmailSignup` |
| `Lead` | `ballot.html` | Ballot finder submitted | `content_name: BallotFinder` |
| `Lead` | `ballot.html` | Reminder signup submitted | `content_name: BallotReminder` |
| `CompleteRegistration` | `ballot.html` & `index.html` | After signup | `content_name` matches the Lead |
| `Lead` | `save-la.html` | Email signup submitted | `content_name: EmailSignup_SaveLA` |

## Lead capture (Supabase)

Every form submission writes a row to `public.leads` in the `pratt-campaign` Supabase project. The same `event_id` UUID is shared between the Supabase row and the Meta Lead event — so you can join Meta ad performance to the actual lead record.

**Schema (key fields):**

| Column | Notes |
|---|---|
| `id` | UUID PK |
| `created_at` | TIMESTAMPTZ |
| `source_page` | `home` / `ballot` / `save-la` |
| `form_type` | `email_signup` / `ballot_finder` / `reminder_signup` / `save_la_signup` |
| `email`, `phone`, `first_name`, `last_name`, `zip` | Self-explanatory |
| `consent_sms` | Bool — captured from the consent checkbox |
| `event_id` | UUID shared with Meta Lead event — join key |
| `fbclid`, `gclid` | Click IDs from URL — direct attribution to ad |
| `utm_source/medium/campaign/content/term` | Read from URL params at submit time |
| `ip`, `user_agent`, `referrer` | Server-captured request context |

**Accessing leads:**

- Supabase Studio: https://supabase.com/dashboard/project/eqppnblxyxmslhgxiror → Table Editor → `leads`
- SQL example: `SELECT created_at, source_page, email, zip, utm_campaign FROM leads ORDER BY created_at DESC LIMIT 100;`
- CSV export: Table Editor → top-right "Export" → CSV
- Weekly hand-off to campaign: filter `WHERE created_at >= now() - interval '7 days'`, export, send to June

**Security model:** RLS is enabled with NO public policies. Only the `service_role` key (server-side only) can read or write. If the public `anon` key is ever exposed, it has zero access.

## Adding PII to CAPI for higher match quality

Right now `/api/track.js` only forwards what the client sends. To boost match quality, modify the front-end handlers to pass the user's email/zip server-side:

```js
// Example — inside submitSignup() in index.html
const email = form.querySelector('input[type=email]')?.value;
window.trackEvent('Lead', { content_name: 'EmailSignup' });
// Add a second call with hashed user data:
fetch('/api/track', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    event_name: 'Lead',
    event_id: crypto.randomUUID(),
    event_source_url: location.href,
    user_data: { email: email }
  })
});
```

The serverless function hashes `email` server-side (SHA-256, lowercased, trimmed) before sending to Meta — never sends raw PII.

## Rollback

If anything breaks: remove `META_PIXEL_ID` from Vercel env vars and redeploy. The placeholder check (`indexOf('__') !== 0`) means `fbq` won't initialize and pages render normally.

## Files NOT to commit to public repos

If this repo ever goes public, ensure these are gitignored:
- `.vercel/` (project linking)
- `.env`, `.env.local` (if you create them locally)

Pixel ID is **not** sensitive (it's visible in any browser's network tab on the live site). CAPI token **is** sensitive — never commit it to git.
