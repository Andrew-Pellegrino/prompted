# Security and reliability audit (November 13, 2026)

Scope: the `platform-dev` code and the deployed preview at https://readprompted.org, with the real
subscriber ledger in private staging. Checked by reading the code, the automated tests (54), browser and
HTTP checks against the live preview, and real Amazon SES and SNS traffic.

## Results

| Area | What was checked | Result |
| --- | --- | --- |
| Admin sign-in | Password hashed (salted), 8 attempts per 15 minutes per address, session cookie HttpOnly, Secure, SameSite=Strict, signed and time-limited; same-origin check on every change | OK |
| Admin API | Every `/api/admin/*` path refuses anonymous requests (tested in the suite; spot-checked live) | OK |
| Private data | Subscriber data only behind the admin API; the built site and `/data/*.json` contain no addresses or the postal address (scanned the build); repository scanned for keys, account number and personal addresses | OK |
| Secrets | All credentials and the postal address are Worker secrets; `wrangler.toml` holds no secret; backups leave out settings whose names contain token or secret | OK |
| Security headers | HSTS everywhere; strict content security policy and `frame-ancestors 'none'` on the dashboard; nosniff; no indexing on the preview | OK (live) |
| Signup | Honeypot, timing check, per-address and per-IP rate limits, double opt-in; preview never emails confirmations | OK |
| Confirm and unsubscribe | A GET only shows a button (mail scanners cannot act); POST acts; one-click List-Unsubscribe (RFC 8058); 160-bit random tokens; unsubscribe never passes through tracking | OK |
| Opt-outs during a send | People who unsubscribe, bounce or complain after a send starts are skipped when their turn comes | **Fixed November 12** |
| Tracking redirects | Only to the stored `http(s)` link for that send; unknown ids go home; query strings ignored; random per-send ids, never the subscriber token; recording failures never break a link | OK (live) |
| SES reports | Only Amazon-signed SNS messages for the pinned topic; certificate host checked; recent; each message once; handshake only via Amazon's host | OK (real messages) |
| Brevo reports | Shared secret compared in constant time | OK |
| Amazon sender | IAM key limited to SES sending and reading; the platform refuses any SES request not from `brief@readprompted.org` through `prompted-newsletter` (IAM cannot enforce the sender for bulk) | OK |
| Audience protection | Two independent locks: `SEND_MODE` and `AUDIENCE_SENDING`; outside production real providers reach only `TEST_RECIPIENTS` and the SES simulator | OK |
| Duplicates | Unique live send per issue; one row per person per send; claim before sending; grouped claims; re-runs send nothing more | OK (rehearsed on the real ledger) |
| Interrupted runs | A stopped run is never blindly resent. With SES, Amazon's signed Send report settles the person; silence for an hour re-queues them; other providers mark failed for review | **Added November 13**; real Send reports verified |
| Test-send failures | A refused key or permission fails a test send at once instead of retrying every minute | **Fixed November 12** |
| Inbound header check | Only `seed-check@readprompted.org`, only mail from our own domain, headers only, last 50 kept | OK |
| Retention | Engagement events 90 days, per-reader counters 400 days, inbound checks 50 rows, webhook ids 30 days | OK |

## Accepted risks (owner's awareness, not defects)

- **Processing time on the free Cloudflare plan.** Send runs measured 19 to 36 ms of processing time
  against a nominal 10 ms limit, with no errors in any run so far. If Cloudflare stops a run, nobody is lost
  or sent twice (see "Interrupted runs"), but that minute's sending is delayed. The certain fix is the
  $5-a-month Workers plan (owner approval needed).
- **Sessions cannot be revoked one by one.** Sign-out clears the cookie; to end every session at once,
  rotate `SESSION_SECRET` (`npm run admin-secret`).
- **The Cloudflare API token is very broad** (owner's choice) and expires February 9, 2027. Replace it with
  a narrower token before then.
- **One admin account**, no roles.
- **The live Prompted Index page overflows on narrow phones** (its subscribe button). The platform's copy is
  fixed at build time; the original on `main` is the Index task's to change.
