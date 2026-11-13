# Prompted platform: handoff

Last updated November 12, 2026, late (infrastructure finished in the sandbox; real ledger staged; rehearsals done). Branch `platform-dev` (created from `main` at `d5c7ce5`). `main` is untouched.

## Goal

A fully independent Prompted publishing platform: website, archive, subscriber database and CRM, signup,
publishing, scheduling, sending and analytics, with no beehiiv and no Miami University infrastructure,
at $0. beehiiv keeps running only as a safety net until an owner-approved cutover.

## Current state (November 13). Read this first; older sections below are history.

**Everything that can be done before Amazon grants production access is done. beehiiv stays the live
sender until the owner's final GO; the audience lock (`AUDIENCE_SENDING`) stays off.**

| Area | State | Evidence |
| --- | --- | --- |
| SES setup | Domain, DKIM, MAIL FROM, configuration set, signed SNS, Auto Validation off, VDM engagement off, optimized shared delivery on, account suppression for bounces and complaints | Live SES API through the dashboard |
| Real SES sending through the platform | Single and **bulk** verified: simulator (success, bounce, complaint, suppression list, out-of-office), our own domain, and the owner's Miami inbox; signed Send, Delivery, Bounce and Complaint reports processed | `SENDING-PROVIDER.md` |
| Authentication at a real receiver | SPF, DKIM and DMARC pass; List-Unsubscribe and one-click present | `/api/admin/inbound-checks` |
| Miami inbox placement | Two test emails delivered and authenticated, but found in **Spam** (owner marked Not spam); a third sent after that, result pending. Not a configuration fault; reputation of a two-day-old domain | `DELIVERABILITY.md`, placement log |
| Interrupted runs | Settled automatically by Amazon's Send report or re-queued after an hour of silence; never blindly resent | Tests and a real Send report |
| Processing time | Send runs 19 to 36 ms vs 10 ms nominal, no errors; damage limited by the settling above | Cloudflare analytics |
| Index section in emails | Adopted, on for every send, per-term clicks | Test emails, dashboard |
| Analytics | First-party, configurable, **off** by default; verified with a real test email | `ANALYTICS.md` |
| Staging ledger | Real 262 (255 / 2 / 5) + 1 owner test record (prospective, never in an audience); beehiiv unchanged since import (checked Nov 13) | Dashboard, beehiiv counts |
| Rehearsals | 25 of 25 against simulated SES on the real ledger (incl. refresh changes and the transition-week export); deployed dry runs: 255 in 4 minutes, twice | `CUTOVER-RUNBOOK.md` |
| Cutover | Runbook and live readiness check; NO-GO only for AWS production access, daily limit, and the owner's Miami and personal-Gmail placement results | `/api/admin/cutover/readiness` |
| Security | Audit done, no open defects; accepted risks listed | `SECURITY-AUDIT.md` |

Remaining, all outside engineering: Amazon's production access; then a real multi-recipient send and the
real rate; the owner's placement reports (Miami now, personal Gmail after production access); the separate
beehiiv-versus-Prompted comparison; the owner's final GO.

## Status at a glance

| Area | State |
| --- | --- |
| Issue archive (31 issues) | **Migrated and verified** on this branch |
| Public site (home, archive, search, issue pages, subscribe, short links, RSS, Index copy) | **Deployed** on the preview at https://readprompted.org |
| Email template from the same issue source | **Built, tested** (structure and text parity). Not yet checked in real inboxes from the domain |
| Pre-send QA | **Built, tested** |
| Subscriber database, CRM, suppression, audit log | **Built, tested** with synthetic data. No real data loaded |
| Signup with attribution, double opt-in, unsubscribe | **Built, tested** |
| CSV import, export, backup and restore | **Built, tested** |
| Publishing pipeline (prepare, test, approve, schedule, send, verify) | **Built, tested** in dry-run mode |
| Amazon SES adapter (single and bulk), status panel, signed SNS reports | **Read-only calls verified live.** Sending and SNS tested with simulated answers only |
| Brevo | **Connected and ready** for an owner-approved test send (free plan, 300 a day) |
| Gmail sending connection | Connected; fallback only; expires about November 18 |
| Email DNS for `readprompted.org` | **In place and verified** by Brevo and Amazon SES |
| Analytics dashboard, beehiiv-era metrics import | **Built, tested** with synthetic figures |
| Real sending | **Blocked:** SES production access, SNS subscription, bulk permission, owner-approved seed tests, cross-group inbox placement, approved postal address |
| Real data migration | **Not started:** needs owner approval |
| Production cutover | **NO-GO** until the tests in `CUTOVER-MANIFEST.md` pass |

## Verified in this session

- `npm test`: 39 of 39 pass.
- **Live preview, 27 of 27 checks pass** (browser-driven, synthetic data): all 31 issue pages serve the full
  text and correct week; old-permalink forwarders; archive full-text search; Index copy (201 terms) and
  links to live anchors; mobile layout and reading gate; every admin endpoint refuses anonymous, forged
  and cross-site requests; noindex and security headers; no address or secret in public files; tracked
  signup through `/s/founders/` stored with full attribution; confirmation requires a click;
  unsubscribe suppresses; dashboard login; CSV import; QA within the free CPU limit; approve and schedule
  for Monday 13:45 UTC.
- **Cloudflare's own cron** started and completed a dry-run send to 30 synthetic subscribers in two
  chunks, with no duplicates.
- **Second live pass, 12 of 12 after one fix:** staged send through the real cron (3 tagged pilot
  subscribers first, then "everyone not yet included": 30 sent, nobody twice, an unsubscribed address
  excluded); compare tool found a planted new address and a planted opt-out and flagged the opt-out as
  dangerous; import with hand-chosen columns kept an unknown column as a custom field and applied the
  opt-out; strict security policy on the dashboard; side contents list and progress bar on issue pages.
- Real local Workers runtime (wrangler dev with a local D1 database) driven by a browser: campaign link,
  signup, confirmation, reading gate, archive search, Index link, dashboard login, CSV import (40 synthetic
  rows), QA, test send, approval, scheduling (resolved to Monday 13:45 UTC, which is 8:45 a.m. Eastern in
  winter), cron-driven dry-run send to 41 synthetic subscribers, no duplicates.
- Not verified: any real email, rendering in real mail clients, real provider APIs.

## Read these next

- `DELIVERY-VERDICT.md` — why independent sending is possible at $0, what it needs, why self-hosted SMTP is not viable.
- `OWNER-SETUP.md` — exact owner steps (Cloudflare, sending identity, postal address, test inboxes).
- `SENDING-PROVIDER.md` — Amazon SES: state, limits, throughput, event handling.
- `ANALYTICS.md` — first-party opens and clicks, the human estimate, privacy and retention.
- `MIGRATION-REPORT.md` — what was migrated, counts, gaps, source anomalies.
- `CUTOVER-MANIFEST.md` — every link and automation, the planned change, test and rollback.

## Decisions made (and why)

- **Cloudflare Workers + D1 + cron**, all on the free plan with no card. One deployable unit. The built site
  is packaged inside the Worker script, because the static-assets upload cannot pass through the cloud
  session's credential proxy (details in `CLAUDE.md`).
- **Issue files in git** (`platform/content/issues/`). Versioned, reviewable, and a scheduled Claude task can
  add one the same way the Index task edits `index/data.json`.
- **Own admin login** (generated high-entropy password, signed session cookie, rate-limited) instead of
  Cloudflare Access, which may ask for a payment method.
- **Dry run by default.** Real providers are used only when `SEND_MODE=live`, and in a preview environment
  only for addresses in `TEST_RECIPIENTS`.
- **Soft reading gate**, matching what beehiiv actually does (its gate also ships the full text).
- **Double opt-in on** for web signups. Imported people are Prospective unless the owner attests consent.

## Domain: `readprompted.org` (owner's, active) — site on it, email DNS in place, Brevo being connected

- The owner bought `readprompted.org` at Cloudflare Registrar and told Claude to use it as the permanent
  domain and to abandon eu.org.
- Done and verified live (11 of 11 checks, synthetic data, no email sent): the Worker is attached to
  `readprompted.org` and `www.readprompted.org` (www redirects), `SITE_URL` is the domain, every page's
  canonical address uses it, the original `workers.dev` address still works, dashboard sign-in works on the
  new address, anonymous access to the dashboard API is refused, and the site is still hidden from search
  engines with the preview banner. This is not a cutover: beehiiv, `main` and the automations are untouched.
- The Gmail sign-in now returns to whichever address the owner is using. To reconnect Gmail from the new
  address the owner must first add `https://readprompted.org/api/admin/gmail/callback` as a second redirect
  address in the Google Cloud client. The existing connection keeps working until it expires.
- November 12: the owner widened the Cloudflare token and created a free Brevo account with
  `readprompted.org` as a sending domain. Claude added Brevo's four records (ownership code, two DKIM
  records as DNS-only, DMARC in monitoring mode) and switched on Cloudflare Email Routing (three MX
  records, one SPF record, Cloudflare's forwarding key). Public DNS answers were checked: one SPF, one
  DMARC, both DKIM records resolve. The full table is in `OWNER-SETUP.md` 6c.
- Forwarding works end to end on Cloudflare's side: the owner verified the destination (the Prompted
  Google account) and the catch-all rule is enabled, so mail to any address at `readprompted.org` is
  forwarded there. Not yet proven with a real incoming message (that would be a real email; ask first).
- The sender address is `brief@readprompted.org` (`FROM_EMAIL` in `wrangler.toml`).
- New dashboard panel (Tools, "Brevo"): shows whether the key works, the domain is authenticated, the
  sender is registered, delivery reports are registered and API sending is enabled, and names the next
  step. "Finish Brevo setup" registers the sender and the delivery-report webhook from the Worker, so the
  webhook secret never leaves the server. It sends no email. Tested with mocked Brevo answers only.
- New safety switch: signup confirmations on the preview are recorded as dry runs and never emailed,
  even to the test inbox, unless `PREVIEW_CONFIRMATIONS = "live"`. Reason: the signup form is public, and
  the owner asked that no real email go out without approval for that send.
- The owner authenticated the domain in Brevo and stored the API key; "Finish Brevo setup" has been run.
  SES was approved the same day; see the sending provider section below.

## Sending provider (November 12): Brevo connected; Amazon SES recommended as the main sender

- **Brevo is fully connected** on the preview: key valid, domain authenticated, sender
  `brief@readprompted.org` active, API sending enabled, delivery reports registered (checked live through
  the dashboard; no email sent). The free plan's 300 a day does not cover a growing list, and the owner
  will pay a small amount for sending.
- **Recommendation given to the owner: Amazon SES** (about $0.16 per 1,000 emails, under $2 a month at
  2,500 subscribers), Brevo free for tests and fallback. Full reasoning, prices, limits and alternatives:
  `SENDING-PROVIDER.md`. **Waiting for the owner's approval; no AWS account exists yet.**
- Built ahead of approval (costs nothing): `platform/src/worker/ses.mjs` (signed requests, send adapter,
  status panel, bounce and complaint reader at `/api/hooks/ses`). Tested with simulated Amazon answers only.
- **November 12, later:** the owner approved SES, opened the AWS account and created the
  `readprompted.org` identity in `us-east-1` with MAIL FROM `bounce.readprompted.org`. Claude added the
  three SES DKIM records (DNS only), the MX and the SPF record on `bounce.readprompted.org`, and checked
  them on two public DNS services. The DMARC line in Amazon's CSV was deliberately not applied (one DMARC
  record already exists). Brevo's records, Email Routing and the website records are unchanged.
  **Claude cannot see inside AWS** (no key is stored yet), so whether Amazon shows the identity as
  Verified must be read by the owner in the SES console, or by the dashboard once keys exist.
- **Auto Validation issue (must hold before any real SES send).** Amazon can decide not to send to an
  address it guesses is undeliverable, bills for it anyway, and reports it as a "Permanent bounce"
  (`EmailValidationSuppressed`). The same shape is used for Amazon's own suppression list. The platform
  maps these to `held`: the message is marked not delivered, the subscriber is never suppressed. The SES
  panel shows the setting and is not "ready" while it is on. The owner should keep it off. Details:
  `SENDING-PROVIDER.md`. Tested with simulated reports only.
- **Next owner step:** confirm the identity shows Verified, keep Auto Validation off, request production
  access (`OWNER-SETUP.md` 6e, with draft text). Before submitting, the owner must confirm how the existing
  subscribers joined, because Amazon asks for an acknowledgement that everyone explicitly asked for the mail.
- Sending pace: a provider can set its own per-minute pace (`maxPerTick`). SES is 30 a minute on the free
  Cloudflare plan. Before the list passes roughly 1,000, build SES bulk requests (50 people per request)
  or move to Workers Paid.

## Domain decision (history; read `DOMAIN-OPTIONS.md`)

- eu.org: the iPhone's `document.txt` turned out to be the blank form, not a result page. Two submissions
  on two devices produced no confirmation and there is no way to see pending requests. Assessed as not
  worth more of the owner's time.
- The owner relaxed the $0 rule for a domain (roughly $5, a little more for a good reason) and asked for a
  comparison. Recommendation written up: `readprompted.org` at Cloudflare Registrar, with
  `promptedbrief.com` as the `.com` alternative. **Nothing has been bought. Do not buy, add a payment
  method, or change the domain plan without the owner's explicit approval.**
- A new automated test proves the domain change is one setting: the site is rebuilt for a different
  address and no file keeps the old one.
- The pending `prompted.eu.org` entry in Cloudflare can stay or be removed by the owner; it costs nothing.

## Deliverability is the open problem (read `DELIVERABILITY.md`)

The owner found all three test messages in Spam and marked them "Not spam". The plain message's headers
show SPF, DKIM and DMARC all passing, and that message had no links or images, so the cause is the new
sending account's reputation, not setup or content. **The owner has asked for no further real test sends
without approval.** Gmail is now a test tool and fallback, not the planned production sender.

Next on this front: the owner applies for the free `eu.org` domain; when it arrives, set up Brevo on it,
move the site onto it, run approved seed tests, announce the new address from beehiiv, and warm up with
staged sends while beehiiv covers everyone not yet moved. If the free domain tests badly, the owner
decides between staying on beehiiv for sending and a small yearly domain cost.

Built for this, deployed and verified live with no email sent: warm-up cap, tracking off by default,
cleaner preview line, sending-domain DNS check in the dashboard.

## First real email tests (November 11) — delivered, but to Spam

The owner connected the dedicated sending account through the dashboard. Verified on the live preview:
audience sending is dry run, test sends use Gmail, one authorised test inbox, only synthetic people in the
database, a test send to any other address is refused.

Three real messages were then sent to the authorised test inbox only, all accepted by Google's API:
the latest issue as a test, a signup confirmation, and a plain message with no links or images.
**None of the three was visible in the recipient's Inbox or All Mail** when checked through the Gmail
connector several minutes later, while other mail arriving in the same minutes was visible. The connector
cannot see the Spam folder. The plain message being missing too points at the brand-new sending account's
reputation, not at the newsletter's content or the `workers.dev` links. Waiting on the owner to look in
the test inbox's Spam folder and in the sending account's inbox for any "message blocked" notice.

Do not send more tests until that is known; repeated filtered mail makes a new account look worse.
Do not treat Gmail as the production sender until tests land in the inbox reliably.

Google reports that the stored sign-in expires on November 18, 2026, which confirms the Google Cloud app is
in "Testing" mode. Durable fix: publish the app (Google Cloud, Audience, Publish app), then click
Reconnect in the dashboard once. The dashboard shows the expiry date and re-checks the sign-in four times
a day.

Also added: the established subject line format ("Prompted | Your Weekly AI Brief | Week of ..."), test
sends that carry a real unsubscribe link and tracking when the test inbox is also a subscriber record,
real confirmation emails to authorised test inboxes, a plain delivery-check button, and a Gmail sign-in
health check with a dashboard warning.

## Added since the first deploy

- **Staged sends.** Schedule to people carrying a tag first, then extend to everyone else. For a careful
  first live send and for keeping Gmail volume gentle.
- **Gmail behaviour.** At most 30 sends a minute (Google allows 60); a rate limit or an expired sign-in
  pauses the send, loses nobody, and shows the reason in the dashboard.
- **Migration tools.** Column chooser for unfamiliar exports, unmapped columns kept as custom fields, and a
  read-only "Compare only" report (counts by status on both sides, missing, extra, differing, and any
  address that is active here but opted out in the source).
- **Security.** Strict content security policy on the dashboard; credentials are filtered out of backups.
- **Site.** Side contents list and progress bar on issue pages, dark-mode fix for the logo, tighter mobile
  header, home page balance.
- **Viability assessment** of personal Gmail as a sender: `DELIVERY-VERDICT.md`.
- Test sends use a connected provider immediately, while audience sending stays in dry run, so the owner
  can send a real test the moment Gmail is connected without any redeploy.
- Live re-check of the import column chooser passed (5 of 5).
- Sending account created by the owner: a dedicated personal Google account (address recorded in the
  dashboard once connected). Google Cloud project, consent screen and OAuth client are in progress.
- Authorised test inbox stored as the `TEST_RECIPIENTS` secret. Postal address still a placeholder by the
  owner's instruction.

## Open blockers and owner actions (in order)

1. Untick Amazon's Opens and Clicks on the event destination and turn off VDM engagement tracking
   (`OWNER-SETUP.md` 6f; the SNS subscription itself is done).
2. Wait for Amazon's production-access answer (up to 96 hours from November 12). Answer any follow-up
   truthfully (draft in 6e).
3. Before cutover: add `ses:SendBulkEmail` to the IAM policy (6g).
4. Approve each seed test send individually, and the postal address for the footer (step 4). Decide
   when tracking may be switched on (`ANALYTICS.md`) and whether to adopt the Index terms block.
5. Continue the Miami delivery investigation privately; decide on outreach and any Miami IT trace.
6. Decide whether issue 31's "fla ws" should be corrected (see `MIGRATION-REPORT.md`).
7. Before February 9, 2027: replace the Cloudflare token (it expires then and is broader than needed).

## State of the preview database: REAL SUBSCRIBER DATA, PRIVATE STAGING (since November 12)

The preview database `prompted-dev` now holds the **real** subscriber ledger as a private, non-sending
staging copy, authorised by the owner on November 12: 262 people from a fresh complete beehiiv read
(255 active, 2 pending, 5 unsubscribed), CRM organisations merged (statuses untouched), 8 suppressions
(5 unsubscribed + 3 Amazon simulator addresses). Comparison with the beehiiv file: in agreement.

Rules while it does:

- Nothing can reach these people. `AUDIENCE_SENDING` is not `enabled`, so every issue send uses the
  dry-run adapter whatever `SEND_MODE` says; outside production real providers may only reach
  `TEST_RECIPIENTS` and Amazon's mailbox simulator; preview signup confirmations are never emailed.
- The data is reachable only through the authenticated admin API. Never copy it into the repository,
  logs, tests, screenshots or chat. Backups go to a private location only.
- Do **not** run the old "empty the database" command: it would delete the staged ledger. Rehearsal sends
  are deleted individually after use (they block a real send of the same issue otherwise).
- Refresh before cutover: re-read beehiiv in full and re-import in migration mode (idempotent; it only
  ever makes statuses more restrictive), then run Compare only.

## Next steps for the next session, in order

1. After the owner's SNS subscription: confirm in the dashboard that reports are connected and that the
   handshake was recorded (`ses.reports_connected` in the audit log).
2. After production access: read the real limits in the dashboard, recompute the pace table, set
   `SES_BULK = "on"` once the IAM permission exists, and propose seed tests (owner approves each).
3. Seed tests (Miami and personal Gmail required; others optional) from
   `brief@readprompted.org`; record each in the placement log.
4. After owner approval: empty the preview database, import the full beehiiv export and the CRM,
   reconcile counts by status against beehiiv.
5. Shadow week next to beehiiv without sending to subscribers; then the staged warm-up.

## Known gaps (honest list)

- No DOCX reader. New issues come in through the text form in `src/lib/import-text.mjs`.
- Sending through SES and real SNS messages are untested against the live service. Expect small fixes on
  first contact. Read-only SES calls are verified.
- Gmail sending gives no bounce webhooks; bounces arrive as mail in the sending account's inbox.
- Open and click tracking is basic and affected by privacy features and link scanners.
- The Index copy at `/index/` gets a small "← Prompted" link added at build time by text replacement;
  if the Index page's header markup changes, the build simply omits it.
- No Turnstile or CAPTCHA. Signup abuse is handled by a honeypot, a timing check and rate limits.
- Admin has a single owner login. No roles.
- Per-issue beehiiv statistics were read for 5 of 31 posts to confirm the shape; none are stored.
