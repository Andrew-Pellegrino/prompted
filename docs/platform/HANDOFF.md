# Prompted platform: handoff

Last updated November 11, 2026. Branch `platform-dev` (created from `main` at `d5c7ce5`). `main` is untouched.

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
| Preview deployment | **Blocked:** needs the owner's free Cloudflare account |
| Real sending | **Blocked:** needs a sending identity and a postal address (owner steps) |
| Real data migration | **Not started:** needs the deployed private database and owner approval |
| Production cutover | **Not started.** NO-GO until the tests in `CUTOVER-MANIFEST.md` pass |

## Verified in this session

- `npm test`: 25 of 25 pass.
- Real local Workers runtime (wrangler dev with a local D1 database) driven by a browser: campaign link,
  signup, confirmation, reading gate, archive search, Index link, dashboard login, CSV import (40 synthetic
  rows), QA, test send, approval, scheduling (resolved to Monday 13:45 UTC, which is 8:45 a.m. Eastern in
  winter), cron-driven dry-run send to 41 synthetic subscribers, no duplicates.
- Not verified: anything on Cloudflare's hosted service, any real email, rendering in real mail clients.

## Read these next

- `DELIVERY-VERDICT.md` — why independent sending is possible at $0, what it needs, why self-hosted SMTP is not viable.
- `OWNER-SETUP.md` — exact owner steps (Cloudflare, sending identity, postal address, test inboxes).
- `MIGRATION-REPORT.md` — what was migrated, counts, gaps, source anomalies.
- `CUTOVER-MANIFEST.md` — every link and automation, the planned change, test and rollback.

## Decisions made (and why)

- **Cloudflare Workers + static assets + D1 + cron**, all on the free plan with no card. One deployable unit.
- **Issue files in git** (`platform/content/issues/`). Versioned, reviewable, and a scheduled Claude task can
  add one the same way the Index task edits `index/data.json`.
- **Own admin login** (generated high-entropy password, signed session cookie, rate-limited) instead of
  Cloudflare Access, which may ask for a payment method.
- **Dry run by default.** Real providers are used only when `SEND_MODE=live`, and in a preview environment
  only for addresses in `TEST_RECIPIENTS`.
- **Soft reading gate**, matching what beehiiv actually does (its gate also ships the full text).
- **Double opt-in on** for web signups. Imported people are Prospective unless the owner attests consent.

## Open blockers and owner actions

1. Create a free Cloudflare account and an API token (`OWNER-SETUP.md` step 1). Unlocks the preview URL.
2. Create a dedicated Google account for sending and apply for a free `eu.org` name (step 3).
3. Choose the postal address for the email footer (step 4).
4. List the inboxes that may receive tests (step 5).
5. Decide whether issue 31's "fla ws" should be corrected (see `MIGRATION-REPORT.md`).

## Next steps for the next session, in order

1. With the Cloudflare token: `wrangler d1 create`, put the id in `wrangler.toml`, apply the migration,
   set secrets, `npm run deploy:preview`, and repeat the browser smoke test against the preview URL.
2. Connect the Gmail adapter; send test issues to the owner's inboxes; compare with the beehiiv email in
   Gmail, Outlook and Apple Mail; adjust the template if needed.
3. After owner approval: import the full beehiiv export and the CRM into the deployed database; reconcile
   counts by status against beehiiv; load per-issue statistics and the growth series.
4. Add the weekly workflow: approved issue text -> `npm run new-issue` -> build -> QA -> test -> approve.
   Run one shadow week next to beehiiv without sending to subscribers.
5. When the domain is approved: Brevo and Resend with DKIM, provider webhooks, then the cutover checklist.

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
