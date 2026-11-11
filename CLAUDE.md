# Prompted — engineering notes for Claude Code sessions

Read `docs/platform/HANDOFF.md` first. It says what is done, what is verified, and what is next.

## What this repository is

- `main` is **production**. GitHub Pages serves it: `index.html` (redirect to beehiiv), `index/` (the public
  Prompted Index), `assets/`. A scheduled task edits `index/data.json` on `main` every Monday.
- `platform-dev` is the **development branch** for the self-owned publishing platform in `platform/`.
  It has never been merged or deployed to production.

## Hard rules

1. Never commit, push, merge or deploy to `main` without the owner's explicit approval.
2. Never edit `index/` on this branch. The platform reads it; only the Index task writes it.
3. $0 additional spend. No paid plans, domains, credits or billing activation without separate approval.
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
| Delivery | `src/worker/providers.mjs` | Replaceable adapters: Brevo, Resend, Gmail API, dry run. |
| Static serving | `src/worker/assets.mjs`, `entry.embedded.mjs` | The built site is packaged inside the Worker script (see "Deploying"). |
| Admin UI | `admin/` | Plain JS; contains no data. |
| Migration | `scripts/extract-beehiiv.mjs` | Public beehiiv pages -> issue JSON, with a verbatim-text check. |

Free-plan constraints that shaped the code: D1 allows 50 queries per Worker invocation (use `db.batch()`),
Workers allow 50 subrequests and about 10 ms CPU per invocation (sends go out in chunks from cron).

## Commands (run inside `platform/`)

```bash
npm install            # wrangler only; the app itself has no runtime dependencies
npm test               # 31 tests, in-memory SQLite behind the D1 interface
npm run build          # SITE_URL=... SITE_ENV=preview|production; also packages dist/ into .generated/ for the Worker
npm run qa -- <slug>   # pre-send QA for one issue
npm run new-issue -- approved.md --write   # approved text -> content/issues/NNN-slug.json (see src/lib/import-text.mjs)
npm run extract        # re-download public beehiiv posts and re-extract (idempotent)
npm run admin-secret   # generate the dashboard password and Worker secrets
npm run dev            # local Worker + local D1 (needs a .dev.vars file; see docs/platform/OWNER-SETUP.md)
```

## Deploying the preview from a Claude Code cloud session

Preview: https://prompted-platform-dev.readprompted.workers.dev (Worker `prompted-platform-dev`, D1 database
`prompted-dev`, cron every minute). It is marked noindex and sends in dry-run mode.

The owner's Cloudflare API token is a network secret for `api.cloudflare.com` in the cloud environment.
The session never sees it: the proxy swaps it in. So run wrangler with any placeholder value:

```bash
export CLOUDFLARE_API_TOKEN=placeholder
```

```bash
SITE_URL=https://prompted-platform-dev.readprompted.workers.dev SITE_ENV=preview npm run build && npx wrangler deploy
```

- Cloudflare's static-assets upload does **not** work through that proxy (it needs a short-lived upload
  ticket in the same header the proxy overwrites). That is why the site is packaged inside the Worker
  script. Do not try to route around the proxy with a relay; that was blocked once and should stay blocked.
- The packaged script is about 0.8 MB gzipped against a 3 MB free limit. `npm run build` fails loudly near
  the limit. At that point deploy with real static assets from a machine with a direct `wrangler login`.
- Personal details and credentials are Worker secrets, never in `wrangler.toml`: `ADMIN_PASSWORD_HASH`,
  `SESSION_SECRET`, `WEBHOOK_SECRET`, `POSTAL_ADDRESS` (still a fake placeholder: the owner has not approved
  a real one), `TEST_RECIPIENTS` (set: the owner's one authorised inbox), `GMAIL_CLIENT_ID`,
  `GMAIL_CLIENT_SECRET`, later `BREVO_API_KEY`, `RESEND_API_KEY`, `FROM_EMAIL`, `REPLY_TO`.
- The Gmail refresh token is stored in the private database by the dashboard's "Connect Gmail" button.
- New migrations must be applied to the preview: `npx wrangler d1 migrations apply DB --remote`.
- Remote database access: `npx wrangler d1 execute DB --remote --command "..."`.
- A new cron schedule takes a few minutes to start firing after the first deploy.

## Where current project sources live (not in this repo)

Project records are private Google Drive documents (owner's account): "00 START HERE — Prompted Current State",
"Prompted Production Specification — Current", "Prompted Project Context — Current", the Growth & Expansion
Roadmap and the Distribution CRM. Read them through the Drive connector; do not copy them here.
beehiiv publication id: `pub_bdc13836-4740-4bea-827d-e076f2059ca4`.

## Style for anything written to the owner

Plain English, no em dashes in prose, explain technical terms by what they do.
