# Prompted — engineering notes for Claude Code sessions

Read `docs/platform/HANDOFF.md` first. It says what is done, what is verified, and what is next.
`docs/platform/WEEKLY-RUNBOOK.md` describes how an issue is published and sent.
Then `docs/platform/SENDING-PROVIDER.md` (Amazon SES is the main sender: set up and verified read-only,
production access under review, SNS subscription is the owner's next step) and `docs/platform/DELIVERABILITY.md`: inbox placement is the open problem, and no real email may be
sent, even to the test inbox, without the owner's approval for that send.

## What this repository is

- `main` is **production**. GitHub Pages serves it: `index.html` (redirect to beehiiv), `index/` (the public
  Prompted Index), `assets/`. A scheduled task edits `index/data.json` on `main` every Monday.
- `platform-dev` is the **development branch** for the self-owned publishing platform in `platform/`.
  It has never been merged or deployed to production.

## Hard rules

1. Never commit, push, merge or deploy to `main` without the owner's explicit approval.
2. Never edit `index/` on this branch. The platform reads it; only the Index task writes it.
3. No further spending without the owner's explicit approval for that purchase. The owner bought the domain
   `readprompted.org` at Cloudflare Registrar in November 2026 (the only cost so far). No paid plans,
   credits or other billing otherwise.
4. Production systems are read-only until an approved cutover: beehiiv, the Distribution CRM, roster files,
   Typefully, scheduled tasks, live sends.
5. No private data in this public repository, ever: no subscriber lists, rosters, CRM notes, exports, API
   keys or per-issue business metrics. Tests and fixtures use synthetic identities (`@example.*`).
6. Infrastructure must stay independent of Miami University (no university domain, mailbox or student-only
   entitlement). Altman Institute branding is editorial identity only.
7. Sending defaults to dry run. `SEND_MODE=live` in a non-production environment only reaches
   `TEST_RECIPIENTS`. Never mail the real audience during development. Test sends (always limited to
   `TEST_RECIPIENTS`) use a real provider as soon as one is connected, even in dry-run mode.
8. Editorial text is never rewritten by code. Renderers wrap approved words in markup and nothing else.

## Architecture (all in `platform/`)

| Part | Where | Notes |
| --- | --- | --- |
| Issue source | `content/issues/NNN-slug.json` | One approved issue file feeds web and email. Schema in `src/lib/issue-model.mjs`. |
| Static site | `src/build.mjs` -> `dist/` | Home, archive with search, issue pages, subscribe, campaign short links `/s/<code>/`, RSS, read-only Index copy. |
| Email | `src/lib/render-email.mjs` | 608px table layout, live masthead text, one stable lockup image. |
| QA | `src/lib/qa.mjs` | Blocks approval on errors (format, links, rendering drift, footer). |
| Worker | `src/worker/` | Cloudflare Worker: public signup, confirm/unsubscribe, tracking, webhooks, admin API, cron sender. |
| Database | `migrations/0001_init.sql` | Cloudflare D1. Private; reachable only through the authenticated admin API. |
| Delivery | `src/worker/providers.mjs` | Replaceable adapters: Amazon SES (`ses.mjs`), Brevo, Resend, Gmail API, dry run. `brevo.mjs` and `ses.mjs` also feed the dashboard's status panels. Decision record: `docs/platform/SENDING-PROVIDER.md`. |
| Static serving | `src/worker/assets.mjs`, `entry.embedded.mjs` | The built site is packaged inside the Worker script (see "Deploying"). |
| Analytics | `src/worker/engagement.mjs` | First-party opens and clicks, raw and estimated human, per link and group; retention. See `docs/platform/ANALYTICS.md`. |
| Admin UI | `admin/` | Plain JS; contains no data. |
| Migration | `scripts/extract-beehiiv.mjs` | Public beehiiv pages -> issue JSON, with a verbatim-text check. |

Free-plan constraints that shaped the code: D1 allows 50 queries per Worker invocation (use `db.batch()`),
Workers allow 50 subrequests and about 10 ms CPU per invocation (sends go out in chunks from cron).

## Commands (run inside `platform/`)

```bash
npm install            # wrangler only; the app itself has no runtime dependencies
npm test               # 52 tests, in-memory SQLite behind the D1 interface
npm run build          # SITE_URL=... SITE_ENV=preview|production; also packages dist/ into .generated/ for the Worker
npm run qa -- <slug>   # pre-send QA for one issue
npm run new-issue -- approved.md --write   # approved text -> content/issues/NNN-slug.json (see src/lib/import-text.mjs)
npm run extract        # re-download public beehiiv posts and re-extract (idempotent)
npm run admin-secret   # generate the dashboard password and Worker secrets
npm run dev            # local Worker + local D1 (needs a .dev.vars file; see docs/platform/OWNER-SETUP.md)
```

## Deploying the preview from a Claude Code cloud session

The platform is served at **https://readprompted.org** (the owner's permanent domain; `www` redirects to
it) and still at the original address https://prompted-platform-dev.readprompted.workers.dev. Same Worker
(`prompted-platform-dev`), same D1 database (`prompted-dev`), cron every minute. It is still in preview
mode: marked noindex, banner shown, sending in dry-run. Being on the domain is not a cutover.

The owner's Cloudflare API token is a network secret for `api.cloudflare.com` in the cloud environment.
The session never sees it: the proxy swaps it in. So run wrangler with any placeholder value:

```bash
export CLOUDFLARE_API_TOKEN=placeholder
```

```bash
SITE_URL=https://readprompted.org SITE_ENV=preview npm run build && npx wrangler deploy
```

- Cloudflare's static-assets upload does **not** work through that proxy (it needs a short-lived upload
  ticket in the same header the proxy overwrites). That is why the site is packaged inside the Worker
  script. Do not try to route around the proxy with a relay; that was blocked once and should stay blocked.
- The packaged script is about 0.8 MB gzipped against a 3 MB free limit. `npm run build` fails loudly near
  the limit. At that point deploy with real static assets from a machine with a direct `wrangler login`.
- Personal details and credentials are Worker secrets, never in `wrangler.toml`: `ADMIN_PASSWORD_HASH`,
  `SESSION_SECRET`, `WEBHOOK_SECRET`, `POSTAL_ADDRESS` (the owner's approved address, set November 12;
  never write it into the repository), `TEST_RECIPIENTS` (the owner's authorised inboxes), `GMAIL_CLIENT_ID`,
  `GMAIL_CLIENT_SECRET`, `BREVO_API_KEY`, `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (IAM user
  `prompted-ses-sender`, restricted policy), `SES_TOPIC_ARN` (the SNS topic; only it is accepted), later
  `RESEND_API_KEY`, `REPLY_TO`.
- The Gmail refresh token is stored in the private database by the dashboard's "Connect Gmail" button.
- New migrations must be applied to the preview: `npx wrangler d1 migrations apply DB --remote`.
- Remote database access: `npx wrangler d1 execute DB --remote --command "..."`.
- The token now has full account and zone access (the owner widened it on November 12). DNS records and
  email forwarding for `readprompted.org` are managed through the Cloudflare API with
  `curl -H "Authorization: Bearer x" https://api.cloudflare.com/client/v4/...` (the proxy swaps the real
  token in). Current records are listed in `docs/platform/OWNER-SETUP.md`, section 6c. Keep exactly one
  SPF record on the bare domain and one DMARC record, and keep every DKIM record (two for Brevo, three for
  Amazon SES) DNS-only (grey cloud). Amazon's own SPF record lives on `bounce.readprompted.org` only.
- Amazon reports sends it chose not to make (Auto Validation, its own suppression list) as "Permanent
  bounces". `ses.mjs` turns those into `held`, which never suppresses a subscriber. Do not undo that.
- SES reports: `/api/hooks/ses` has no secret in its address. It trusts only Amazon-signed SNS messages
  for `SES_TOPIC_ARN` (`src/worker/sns.mjs`), recent, once each (`webhook_messages`). Do not add a URL
  key to it and do not weaken the signature check. Brevo's hook keeps its `?key=` secret.
- SES stays out of the sending chain until Amazon grants production access (read from the account every
  30 minutes). Bulk mode (`SES_BULK`) needs `ses:SendBulkTemplatedEmail` (and
  `ses:SendBulkEmail`) on the IAM policy; in the sandbox each recipient's identity must be in the policy too.
- Engagement tracking is first-party only and **off** (`TRACK_OPENS`, `TRACK_CLICKS`) until the owner
  authorises inbox-placement tests. Tracking URLs carry a random per-send `track_id`, never the subscriber
  token. Keep click redirects limited to stored `http(s)` links and keep them working when recording fails.
  Amazon's own open and click tracking stays off. The Index terms email block (`INDEX_TERMS_EMAIL`) is not adopted.
- **The preview database holds the REAL subscriber ledger as private staging (since November 12).** See
  `docs/platform/HANDOFF.md`, "State of the preview database". Never export it into the repository, tests,
  logs or chat, and never run a blanket delete on it.
- `AUDIENCE_SENDING` is the hard lock for the real audience: anything but `"enabled"` forces issue sends to
  the dry-run adapter. Only an approved cutover sets it (`docs/platform/CUTOVER-RUNBOOK.md`).
- Amazon's mailbox simulator (`*@simulator.amazonses.com`) is allowed as a test recipient outside
  production, only through SES. Use it to test SES without reaching a person.
- `GET /api/admin/cutover/readiness` is the live go/no-go check (read-only).
- `FROM_EMAIL` is a plain setting in `wrangler.toml` (`brief@readprompted.org`), not a secret.
- Signup confirmations on the preview never leave the platform unless `PREVIEW_CONFIRMATIONS = "live"`.
- A new cron schedule takes a few minutes to start firing after the first deploy.
- Cloudflare's management API rate-limits bursts (error 971, wait a few minutes). Do not fire many
  `wrangler d1 execute` calls in a row; read state through the dashboard's own `/api/admin/*` instead.

## Where current project sources live (not in this repo)

Project records are private Google Drive documents (owner's account): "00 START HERE — Prompted Current State",
"Prompted Production Specification — Current", "Prompted Project Context — Current", the Growth & Expansion
Roadmap and the Distribution CRM. Read them through the Drive connector; do not copy them here.
beehiiv publication id: `pub_bdc13836-4740-4bea-827d-e076f2059ca4`.

## Style for anything written to the owner

Plain English, no em dashes in prose, explain technical terms by what they do.
