#!/usr/bin/env python3
"""
Bulk-import mayorpratt.com subscriber list into Supabase leads table.

Usage:
  1. Get your Supabase service role key:
     vercel env pull .env.local (from landing-pages dir)
     OR copy from Vercel dashboard -> Settings -> Env Vars -> SUPABASE_SERVICE_ROLE_KEY

  2. Run:
     SUPABASE_URL="https://eqppnblxyxmslhgxiror.supabase.co" \\
     SUPABASE_SERVICE_ROLE_KEY="eyJ..." \\
     python3 scripts/import_mayorpratt.py "/path/to/Full HF -- 05-11-26.csv"

What it does:
  - Parses the CSV, normalizes emails to lowercase, cleans phone numbers (E.164),
    extracts 5-digit ZIPs.
  - Dedupes against itself, then against any rows already in `leads` where
    source_page='mayorpratt.com' (so re-runs are idempotent).
  - Tags every row: source_page='mayorpratt.com', form_type='import_mayorpratt',
    consent_sms=false.
  - Calls the server-side function public.bulk_import_mayorpratt() in batches of 500.
  - Prints progress to stdout.

Safety:
  - Service role key is server-side only; never commit it.
  - Function is idempotent; safe to re-run if interrupted.
"""

import csv
import json
import os
import re
import sys
import time
import urllib.request
import urllib.error

EMAIL_RE = re.compile(r'^[^\s@]+@[^\s@]+\.[^\s@]+$')
BATCH_SIZE = 500


def clean_phone(p):
    if not p:
        return ""
    p = p.strip().lstrip("'").strip()
    cleaned = re.sub(r'[^\d+]', '', p)
    if not cleaned:
        return ""
    if not cleaned.startswith('+'):
        digits = re.sub(r'\D', '', cleaned)
        if len(digits) == 10:
            cleaned = '+1' + digits
        elif len(digits) == 11 and digits.startswith('1'):
            cleaned = '+' + digits
        else:
            return ""
    if len(cleaned) < 11 or len(cleaned) > 16:
        return ""
    return cleaned


def clean_zip(z):
    if not z:
        return ""
    z = z.strip()
    m = re.match(r'(\d{5})(-?\d{4})?', z)
    return m.group(0) if m else ""


def clean_name(n):
    if not n:
        return ""
    n = n.strip()
    return n[:100] if n else ""


def call_rpc(url, key, payload):
    """Call the public.bulk_import_mayorpratt() function via PostgREST RPC."""
    rpc_url = f"{url.rstrip('/')}/rest/v1/rpc/bulk_import_mayorpratt"
    body = json.dumps({"rows": payload}).encode('utf-8')
    req = urllib.request.Request(
        rpc_url,
        data=body,
        method='POST',
        headers={
            'Content-Type': 'application/json',
            'apikey': key,
            'Authorization': f'Bearer {key}',
        }
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = resp.read().decode('utf-8')
            # Function returns an integer (count of rows inserted)
            try:
                return int(json.loads(data))
            except (ValueError, json.JSONDecodeError):
                return data
    except urllib.error.HTTPError as e:
        return f"HTTP {e.code}: {e.read().decode('utf-8', errors='ignore')}"


def main():
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <path-to-csv>", file=sys.stderr)
        sys.exit(1)

    csv_path = sys.argv[1]
    supabase_url = os.environ.get('SUPABASE_URL')
    service_key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')

    if not supabase_url or not service_key:
        print("ERROR: Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars.", file=sys.stderr)
        print("       Get key from Vercel: vercel env pull .env.local", file=sys.stderr)
        sys.exit(1)

    print(f"Reading {csv_path}...")
    rows = []
    seen = set()
    with open(csv_path, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for r in reader:
            email = (r.get('email') or '').strip().lower()
            if not email or not EMAIL_RE.match(email):
                continue
            if email in seen:
                continue
            seen.add(email)
            rows.append([
                email,
                clean_name(r.get('firstName')),
                clean_name(r.get('lastName')),
                clean_zip(r.get('zip')),
                clean_phone(r.get('phoneNumber') or r.get('phone_number')),
            ])

    total = len(rows)
    with_phone = sum(1 for r in rows if r[4])
    with_zip = sum(1 for r in rows if r[3])
    print(f"  {total:,} unique valid emails")
    print(f"  {with_phone:,} with phone")
    print(f"  {with_zip:,} with zip")

    num_batches = (total + BATCH_SIZE - 1) // BATCH_SIZE
    print(f"\nImporting in {num_batches} batches of {BATCH_SIZE}...")
    total_inserted = 0
    start = time.time()
    for i in range(num_batches):
        batch = rows[i * BATCH_SIZE:(i + 1) * BATCH_SIZE]
        result = call_rpc(supabase_url, service_key, batch)
        if isinstance(result, int):
            total_inserted += result
            print(f"  Batch {i + 1}/{num_batches}: +{result} (running total: {total_inserted:,})")
        else:
            print(f"  Batch {i + 1}/{num_batches}: ERROR - {result}", file=sys.stderr)
            sys.exit(1)

    elapsed = time.time() - start
    skipped = total - total_inserted
    print(f"\nDone in {elapsed:.1f}s")
    print(f"  Inserted: {total_inserted:,}")
    print(f"  Skipped as duplicates: {skipped:,}")
    print(f"  CSV total: {total:,}")


if __name__ == '__main__':
    main()
