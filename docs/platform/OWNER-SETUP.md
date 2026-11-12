# Owner setup steps

Everything here is free and none of it involves Miami University or beehiiv. Never paste a password, key or
token into a chat or into a file in this repository. Where a step needs a secret, you type it straight into
Cloudflare's own settings page.

Site (still in preview mode): https://readprompted.org
Dashboard: https://readprompted.org/admin/
The original address https://prompted-platform-dev.readprompted.workers.dev keeps working too.

## 1. Cloudflare — DONE

- Free account created by the owner. API token stored as a network secret for `api.cloudflare.com` in the
  Claude Code cloud environment. Claude deploys with it without ever seeing it.
- The Claude desktop "Cloudflare" connector is **not needed**. Leave it disconnected.
- `workers.dev` subdomain: `readprompted` (change it any time under Workers & Pages, Subdomain).
- Database `prompted-dev` created; schema applied.
- Nothing was billed and no payment method was added.

## 2. Dashboard password — DONE

Generated and stored as a Worker secret. The password itself was handed to the owner in a temporary file,
not in chat and not in this repository. To replace it, ask Claude to run `npm run admin-secret` and store
the new values.

## 3. Sending account (Gmail API)

This gives Prompted its own sender, with no domain needed. About 500 recipients per rolling day
(third-party figure for personal Google accounts), which covers the current list in one morning.

### 3a. Create the Google account — DONE

1. Open https://accounts.google.com/signup in a private browser window.
2. Create a **personal** account just for Prompted. The address becomes the newsletter's From address,
   so pick something like `readprompted@gmail.com` or `promptedbrief@gmail.com`.
   Use your own phone number for verification. Do not use your university account anywhere in this step.
3. After it is created, open https://myaccount.google.com/security and turn on **2-Step Verification**.
4. In Gmail settings for this account, set the display name to `Prompted`
   (gear icon, See all settings, Accounts, "Send mail as", edit info).

### 3b. Create the Google Cloud project (signed in as the new account)

1. Open https://console.cloud.google.com and accept the terms. No billing account is needed; if a page
   asks you to start a free trial or add a card, close it and continue.
2. Top bar, project picker, **New project**. Name: `Prompted`. Create, then select it.
3. Open https://console.cloud.google.com/apis/library/gmail.googleapis.com and click **Enable**.

### 3c. Consent screen

1. Open https://console.cloud.google.com/auth/overview and click **Get started**.
2. App name: `Prompted`. User support email: the new address. Next.
3. Audience: **External**. Next.
4. Contact email: the new address. Next. Agree to the policy. **Create**.
5. Left menu, **Audience**. Under "Publishing status" click **Publish app** and confirm.
   This matters: while an app is in "Testing", Google expires the sign-in every 7 days.
   If Google refuses to publish without a verification review, leave it in Testing, add the new address
   under "Test users", and tell Claude. The only cost is clicking "Connect Gmail" again once a week.

### 3d. OAuth client

1. Left menu, **Clients**, **Create client**.
2. Application type: **Web application**. Name: `Prompted platform`.
3. Under **Authorized redirect URIs** click **Add URI** and paste exactly:

   `https://prompted-platform-dev.readprompted.workers.dev/api/admin/gmail/callback`

4. **Create**. A box shows a **Client ID** and a **Client secret**. Keep that box open for the next step.

### 3e. Give the two values to Cloudflare (not to Claude)

1. Open https://dash.cloudflare.com, then **Workers & Pages**, then `prompted-platform-dev`,
   then **Settings**, then **Variables and Secrets**.
2. Click **Add**. Type: **Secret**. Name: `GMAIL_CLIENT_ID`. Value: paste the Client ID. Save.
3. Click **Add**. Type: **Secret**. Name: `GMAIL_CLIENT_SECRET`. Value: paste the Client secret. Save
   (choose **Deploy** if it asks).

   Use type Secret, not Text. Text values are replaced on the next deploy.

### 3f. Connect

1. Open the dashboard, sign in, go to **Tools**. Under "Gmail sending account" click **Connect Gmail**.
2. Choose the new Prompted account. Google shows "Google hasn't verified this app" because the app is
   yours and unreviewed: click **Advanced**, then **Go to Prompted (unsafe)**.
3. Leave the box "Send email on your behalf" ticked. Continue.
4. You land back on the dashboard. It should read "Connected as" followed by the new address.

Then, in the dashboard, open **Publish**, pick the latest issue and click **Send test**. That sends one
real email to your authorised test inbox and nothing to anyone else. Audience sending stays in dry-run
mode until you approve a real send.

## 4. Postal address for the footer

US law (CAN-SPAM) requires a physical postal address in every issue. The preview currently uses an
obviously fake placeholder. The owner has proposed an address and been shown exactly how the footer will
look. It is stored only as the Worker secret `POSTAL_ADDRESS` once approved, never in this repository.
Whatever is chosen is visible to every subscriber and to anyone an issue is forwarded to.

## 5. Authorised test inboxes

Tell Claude which of your own addresses may receive test emails. One Gmail, one Outlook or Hotmail, and
one Apple iCloud address give the best rendering coverage; one address is enough to start.
Claude stores them as the Worker secret `TEST_RECIPIENTS`.

## 6. The domain: `readprompted.org`

**Bought by the owner at Cloudflare Registrar, November 2026.** It is active in the same Cloudflare account
that runs the platform. The eu.org route is abandoned (two submissions produced no confirmation; details in
`DOMAIN-OPTIONS.md`). The leftover `prompted.eu.org` entry in Cloudflare can be deleted by the owner at any
time; it costs nothing and does nothing.

### 6a. Website on the domain — DONE

The platform is served at https://readprompted.org, `www` redirects to it, and the original
`workers.dev` address still works. It is still in preview mode (hidden from search engines, banner shown,
dry-run sending). Verified live: all 31 issues, archive search, the Index copy, mobile layout, tracked
signup, dashboard sign-in, and refusal of anonymous access to the dashboard API.

Dashboard: https://readprompted.org/admin/ (same password).

### 6b. Let Claude manage the domain's DNS and email forwarding — DONE (November 12)

The owner widened the access token. Claude can now read and edit DNS records and email forwarding.

### 6c. DNS records for email — DONE (November 12)

These records exist on `readprompted.org`. None of them is secret. There is exactly one SPF record and one
DMARC record, and the two DKIM records are "DNS only" (grey cloud), as Brevo requires.

| Type | Name | Value | What it does |
| --- | --- | --- | --- |
| TXT | `readprompted.org` | `brevo-code:0fa23a0a352515c0bfb28a230f53a23d` | Proves to Brevo that we own the domain |
| CNAME | `brevo1._domainkey` | `b1.readprompted-org.dkim.brevo.com` | DKIM: lets Brevo sign our mail as the domain |
| CNAME | `brevo2._domainkey` | `b2.readprompted-org.dkim.brevo.com` | DKIM, second key |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:rua@dmarc.brevo.com` | DMARC in monitoring mode: asks mailbox providers for reports |
| MX (3) | `readprompted.org` | `route1/2/3.mx.cloudflare.net` | Receives mail for the domain (Cloudflare Email Routing) |
| TXT | `readprompted.org` | `v=spf1 include:_spf.mx.cloudflare.net ~all` | SPF for forwarded mail (added by Email Routing) |
| TXT | `cf2024-1._domainkey` | (Cloudflare's key) | Signs forwarded mail (added by Email Routing) |

Brevo sends from its own bounce address, so Brevo mail passes SPF on Brevo's side and passes DMARC through
the DKIM records above. Do not add a second SPF record for Brevo: two SPF records break both.

**Forwarding — DONE (November 12).** Email Routing is on, the owner confirmed the destination inbox (the
Prompted Google account), and a "catch-all" rule forwards mail sent to any address at `readprompted.org`
to that inbox. Replies to an issue and bounce notices therefore reach the owner. To forward to a different
inbox later, add it as a destination in Cloudflare (**Email**, **Email Routing**, **Destination
addresses**), confirm it, and point the catch-all rule at it.

### 6d. Sending provider: Brevo

1. Free account created by the owner with the Prompted Google account. DONE.
2. `readprompted.org` added in Brevo as a sending domain; records added to DNS by Claude. DONE.
3. **Owner:** in Brevo, open **Senders, Domains & Dedicated IPs**, **Domains**, and click
   **Authenticate** (or **Verify**) next to `readprompted.org`. All records should show green.
4. **Owner:** create an API key in Brevo (**SMTP & API**, **API Keys**, **Generate a new API key**, name it
   "Prompted platform") and store it in Cloudflare without showing it to anyone: Cloudflare dashboard,
   **Workers & Pages**, `prompted-platform-dev`, **Settings**, **Variables and Secrets**, **Add**, type
   **Secret**, name `BREVO_API_KEY`, paste the key, **Deploy**.
5. In the platform dashboard, **Tools**, the **Brevo** panel shows what is still missing. Click
   **Finish Brevo setup**: it registers the sender address `brief@readprompted.org` and asks Brevo to
   report deliveries, bounces and complaints back to the platform. It sends no email.
6. If the panel says sending through the API is not enabled, ask Brevo support to enable it, saying
   plainly that it is a weekly newsletter to people who subscribed, sent from our own software.

All six steps are DONE as of November 12: the dashboard's Brevo panel reports "Ready for an approved test
send".

No test email is sent until the owner approves that specific send.

### 6e. Main sender: Amazon SES (needs the owner's approval first)

Why, what it costs and what could go wrong: `SENDING-PROVIDER.md`. In short: about $0.16 per 1,000
emails, no monthly fee, under $2 a month at 2,500 subscribers. A payment card is required to open the
account.

1. **Owner:** create an AWS account at https://aws.amazon.com (button **Create account**), using the
   Prompted Google account's address, account name "Prompted". Choose the **Paid** account plan when asked
   (the Free plan closes the account after six months; the sign-up credits apply to both). Choose the free
   **Basic** support plan.
2. **Owner:** turn on two-step sign-in for the account (top right menu, **Security credentials**,
   **Assign MFA device**).
3. Then tell Claude. The following steps are in `SENDING-PROVIDER.md` and will be given one at a time.

## 7. Private data migration (only after tests pass and you approve)

1. In beehiiv: **Subscribers**, **Export**, full export including inactive subscribers. Save it to your
   owner-only Drive folder, not to this repository.
2. Claude empties the synthetic data from the preview database.
3. Dashboard, **Import**, choose the file, "Kind of file": **Full ledger from another system**, review the
   preview, import. Statuses, dates, sources and suppressions are kept.
4. Export the Contacts tab of the Distribution CRM as CSV and import it as **New contacts**, added as
   **Prospective**. Existing people are enriched, never duplicated or re-activated.
5. Per-issue statistics: Claude reads them through the beehiiv connector and loads them under
   **Tools, Import historical metrics**.
