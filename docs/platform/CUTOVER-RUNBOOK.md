# Cutover runbook: beehiiv to Prompted's own platform

Use this only after the owner approves a cutover date. Until then beehiiv stays the live sender and the
platform stays in preview (`SITE_ENV = "preview"`, `SEND_MODE = "dryrun"`, `AUDIENCE_SENDING = ""`).
`CUTOVER-MANIFEST.md` lists every link and automation that changes; this file is the order of work.

Rehearsed on November 12, 2026 against the real staged ledger (see "Rehearsal record" at the end).

## The switches (all in `platform/wrangler.toml` unless marked secret)

| Switch | Preview (today) | Production | What it does |
| --- | --- | --- | --- |
| `SITE_ENV` | `preview` | `production` | Search engines allowed, preview banner removed, test-only fences lifted |
| `SEND_MODE` | `dryrun` | `live` | Real providers may be used |
| `AUDIENCE_SENDING` | `""` | `enabled` | Second, independent lock: without it the audience only ever gets dry runs |
| `SES_USE_IN_SANDBOX` | `true` | `""` | Test sends through SES before production access |
| `SES_BULK` | `""` until the IAM fix | `on` | Bulk requests (needed for the Monday pace) |
| `DRYRUN_BULK` | `on` | `""` | Rehearsal pacing only |
| `TRACK_OPENS`, `TRACK_CLICKS` | `false` | owner's decision after the tracking seed test | First-party analytics |
| `PREVIEW_CONFIRMATIONS` | `""` | not used in production | Signup confirmations are real in production |
| `POSTAL_ADDRESS` (secret) | set | set | Compliance footer |

A cutover is one deploy that changes the first three switches together, after every check below passes.

## T minus 7 days to T minus 1 day

1. `GET /api/admin/cutover/readiness` must show **go: true**. It checks live: SES production access and
   limits, domain DKIM and MAIL FROM, signed SNS reports, Auto Validation off, Amazon tracking off, bulk on,
   SPF/DKIM/DMARC/MX, postal address, a beehiiv ledger imported within 24 hours, suppressions loaded,
   and inbox placement recorded as "inbox" for Miami, Gmail, Outlook and iCloud from the domain.
2. Seed tests (each approved by the owner): the latest issue to the seed inboxes, first without tracking,
   then with tracking. Record each result in the dashboard placement log. The Miami cross-group check in
   `CUTOVER-MANIFEST.md` must pass.
3. Announce the new sender (`brief@readprompted.org`) in the last one or two beehiiv issues and ask readers
   to add it to their contacts.
4. Decide the warm-up: `WARMUP = "YYYY-MM-DD,first-day cap,daily growth"` with beehiiv covering everyone the
   platform has not yet reached, or a single full send if production limits and placement allow.

## T minus 1 day (Sunday)

1. Prepare the issue as today (approved text, `npm run new-issue`, build, QA, test send to the owner).
2. Fresh ledger: read the complete beehiiv list (all statuses), save it privately, and import it with the
   dashboard importer in migration mode. Then run **Compare only** with the same file: it must report
   `in_agreement: true`, nothing missing, no status differences, no re-activation risk.
3. Back up: `GET /api/admin/export/backup.json` to a private location (never the repository).
4. In beehiiv, **unschedule** Monday's send (the owner does this). Nobody may get two emails.

## Cutover (Monday morning, before 8:30 a.m. Eastern)

1. In `wrangler.toml`: `SITE_ENV = "production"`, `SEND_MODE = "live"`, `AUDIENCE_SENDING = "enabled"`,
   `SES_USE_IN_SANDBOX = ""`, `DRYRUN_BULK = ""`, `SES_BULK = "on"`, and `SITE_URL` stays
   `https://readprompted.org`. Then:
   `export CLOUDFLARE_API_TOKEN=placeholder` and
   `SITE_URL=https://readprompted.org SITE_ENV=production npm run build && npx wrangler deploy`.
2. Check: `/robots.txt` allows crawling, no preview banner, `GET /api/admin/providers` shows the audience
   chain `ses > brevo` (not `dryrun`), `GET /api/admin/cutover/readiness` still go.
3. Approve and schedule the issue in the dashboard (default slot 8:45 a.m. Eastern). With
   `WARMUP` set, the platform stops at the day's cap; beehiiv covers the rest that week (send from beehiiv
   **only** to people the platform has not reached: export the platform's sent list first).
4. Watch from 8:45: the send page shows sent, delivered, bounced, complained and failed counts within
   minutes; the SES panel shows Amazon's limits and any pause reason.

## Links and automations (after the first good send)

From `CUTOVER-MANIFEST.md`, rows 1 to 13, each with its own approval where it touches `main` or a
scheduled task: beehiiv signup links de-linked (beehiiv stays online), GitHub Pages root redirect,
Index subscribe buttons (right after a Monday Index run), LinkedIn task link target, Drive records.

## Failure handling during a send

| What you see | What it means | What to do |
| --- | --- | --- |
| "Amazon SES says not now" | Rate or daily limit reached, or Amazon paused sending | Nothing; the send resumes on the next run. If paused, read the SES console |
| "refused the access key or its permissions" | IAM problem | Fix the policy; the send resumes by itself; nobody is lost |
| Failed recipients | Rejected addresses | Check the reason; retry only after checking Amazon's log (`Retry failed`) |
| "unconfirmed: handed to provider but no result recorded" | A run stopped mid-request | Check Amazon's log before retrying, or that person may get two copies |
| Bounce or complaint rate climbing | List or content problem | Cancel the rest of the send; switch back (below) |

## Rollback (any time; minutes)

1. Set `AUDIENCE_SENDING = ""` and `SEND_MODE = "dryrun"` and deploy. Sending stops at the next run; people
   already sent stay sent; nobody is sent twice.
2. In the dashboard, cancel any scheduled send.
3. Re-enable beehiiv's send for anyone the platform did not reach (export the send's recipients with
   status `sent` and exclude them in beehiiv).
4. Unsubscribes, bounces and complaints recorded by the platform must be copied to beehiiv the same day
   (export `GET /api/admin/suppressions`); this keeps consent consistent in both systems.
5. Links changed on `main` are reverted with `git revert` (owner approval).
6. `SITE_ENV = "preview"` and deploy if the public site itself must go back to preview.

## Rehearsal record (November 12, 2026)

- **Real ledger, private staging:** fresh beehiiv list read in full (262: 255 active, 2 pending, 5
  unsubscribed), imported in migration mode, CRM organisations merged without status changes, platform
  comparison `in_agreement: true`. Backups before and after kept privately (not in the repository).
- **Local rehearsal against simulated Amazon (21 of 21 checks):** full Monday send of 255 in 5 cron runs,
  each person exactly once, own unsubscribe link and header, pending and unsubscribed never queued,
  rejections, throttling, a dropped connection, a stale hand-off and an owner retry handled; unsubscribes
  and suppressions mid-send skipped; warm-up 50 / 125 / 237 / 255 over four days; tag-first staged send
  then extension, nobody twice.
- **Real Amazon SES (mailbox simulator, no person):** single sends delivered and reported back through
  signed SNS within a second; real bounce and complaint reports suppressed the addresses. Bulk requests
  refused by IAM (needs `ses:SendBulkTemplatedEmail`); nothing sent.
- **Deployed dry-run on the real staging database (Cloudflare cron and D1):** 255 people in 4 minutes
  (20:58:19 to 21:02:22 UTC), 56 a minute as designed, every one through the dry-run adapter, no errors.
  The rehearsal send was then deleted. **Risk found:** those runs used about 26 to 35 ms of processing
  time each against the free plan's nominal 10 ms. Cloudflare recorded no errors, but that headroom is not
  guaranteed. If CPU errors ever appear, lower `SES_CALLS_PER_TICK` (slower but cheaper) or move to Workers
  Paid ($5 a month, owner approval needed).
- **Live readiness check (`/api/admin/cutover/readiness`):** NO-GO with 4 blockers, all external: SES
  production access, the daily limit that comes with it, bulk sending (IAM fix), inbox placement evidence.
- **Not rehearsed for real:** a production-mode deploy (would make the site public and unlock sending);
  rehearsed only as configuration review and tests. A real multi-recipient SES send (needs production access).
