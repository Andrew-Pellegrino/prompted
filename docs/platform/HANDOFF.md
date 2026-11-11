# Prompted platform: handoff

Last updated November 11, 2026 (preview deployed). Branch `platform-dev` (created from `main` at `d5c7ce5`). `main` is untouched.

## Goal

A fully independent Prompted publishing platform: website, archive, subscriber database and CRM, signup,
publishing, scheduling, sending and analytics, with no beehiiv and no Miami University infrastructure,
at $0. beehiiv keeps running only as a safety net until an owner-approved cutover.

## Status at a glance

| Area | State |
| --- | --- |
| Issue archive (31 issues) | **Migrated and verified** on this branch |
| Public site (home, archive, search, issue pages, subscribe, short links, RSS, Index copy) | **Built, tested locally.** Not deployed |
| Email template from the same issue source | **Built, tested** (structure and text parity). Not yet checked in real inboxes |
| Pre-send QA | **Built, tested** |
| Subscriber database, CRM, suppression, audit log | **Built, tested** with synthetic data. No real data loaded |
| Signup with attribution, double opt-in, unsubscribe | **Built, tested** |
| CSV import, export, backup and restore | **Built, tested** |
| Publishing pipeline (prepare, test, approve, schedule, send, verify) | **Built, tested** in dry-run mode |
| Delivery adapters: Brevo, Resend, Gmail API | **Written against documented APIs, tested with mocked HTTP.** Never run against a real account |
| Analytics dashboard, beehiiv-era metrics import | **Built, tested** with synthetic figures |
| Preview deployment | **Deployed and verified:** https://prompted-platform-dev.readprompted.workers.dev (dry-run sending, noindex, synthetic data only) |
| Gmail sending connection | **Built and tested with mocked Google responses.** Waiting for the owner's Google account and OAuth client |
| Real sending | **Blocked:** needs the Gmail connection, authorised test inboxes and an approved postal address |
| Real data migration | **Not started:** needs the deployed private database and owner approval |
| Production cutover | **Not started.** NO-GO until the tests in `CUTOVER-MANIFEST.md` pass |

## Verified in this session

- `npm test`: 32 of 32 pass.
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

## First real email tests (November 11) — delivery NOT yet confirmed

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

## Open blockers and owner actions

1. Create the dedicated Google sending account and OAuth client, add two secrets in Cloudflare, click
   "Connect Gmail" (`OWNER-SETUP.md` step 3).
2. Name the inboxes that may receive test emails (step 5).
3. Approve or change the postal address shown in the footer preview (step 4). The preview currently uses
   a clearly fake placeholder address; QA flags it.
4. Apply for a free `eu.org` name (optional now, better From address later).
5. Decide whether issue 31's "fla ws" should be corrected (see `MIGRATION-REPORT.md`).

## State of the preview database

It holds **synthetic data only**: 31 `@example.org` people (one unsubscribed), one `@example.com` signup
test, and completed dry-run sends of issues 30 and 31. Empty it before any real import:

```bash
npx wrangler d1 execute DB --remote --command "DELETE FROM send_recipients; DELETE FROM send_links; DELETE FROM sends; DELETE FROM delivery_events; DELETE FROM import_rows; DELETE FROM import_batches; DELETE FROM people; DELETE FROM organizations; DELETE FROM suppressions; DELETE FROM provider_usage; DELETE FROM rate_limits;"
```

## Next steps for the next session, in order

1. When the owner has connected Gmail and named test inboxes: store `TEST_RECIPIENTS` as a secret, set
   `SEND_MODE = "live"` in `wrangler.toml` for the preview (it can still only reach test inboxes), deploy,
   send a test issue from the dashboard, and compare with the beehiiv email in Gmail, Outlook and Apple
   Mail. Fix the template where it differs.
2. Set the approved `POSTAL_ADDRESS` secret.
3. After owner approval: empty the preview database, import the full beehiiv export and the CRM, reconcile
   counts by status against beehiiv, load per-issue statistics and the growth series.
4. Weekly workflow: approved issue text -> `npm run new-issue` -> build -> QA -> test -> approve.
   Run one shadow week next to beehiiv without sending to subscribers.
5. When a domain is approved: Brevo and Resend with DKIM, provider webhooks, then the cutover checklist.

## Known gaps (honest list)

- No DOCX reader. New issues come in through the text form in `src/lib/import-text.mjs`.
- Provider adapters are untested against live APIs. Expect small fixes on first contact.
- Gmail sending gives no bounce webhooks; bounces arrive as mail in the sending account's inbox.
- Open and click tracking is basic and affected by privacy features and link scanners.
- The Index copy at `/index/` gets a small "← Prompted" link added at build time by text replacement;
  if the Index page's header markup changes, the build simply omits it.
- No Turnstile or CAPTCHA. Signup abuse is handled by a honeypot, a timing check and rate limits.
- Admin has a single owner login. No roles.
- Per-issue beehiiv statistics were read for 5 of 31 posts to confirm the shape; none are stored.
