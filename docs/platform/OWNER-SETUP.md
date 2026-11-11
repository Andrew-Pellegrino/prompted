# Owner setup steps

Everything here is free and none of it involves Miami University or beehiiv. Never paste a password, key or
token into a chat or into a file in this repository. Where a step needs a secret, you type it straight into
Cloudflare's own settings page.

Preview site: https://prompted-platform-dev.readprompted.workers.dev
Dashboard: https://prompted-platform-dev.readprompted.workers.dev/admin/

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

## 6. The dedicated domain: `prompted.eu.org`

Why: mail from the Gmail account authenticated correctly but landed in Spam (see `DELIVERABILITY.md`).
A domain of our own lets Prompted build a reputation that belongs to it and can move between providers.
It is free, and it is not a guarantee: a new domain starts with no reputation and has to be warmed up.

Status: eu.org contact handle created and confirmed by the owner (personal iCloud address).
`prompted.eu.org`, `readprompted.eu.org` and `promptedbrief.eu.org` were all unused on November 11.
`prompted.eu.org` is the first choice; `readprompted.eu.org` is the fallback if it is refused.

eu.org's rules that matter here (from its policy page): the service is meant for individuals and
non-profits, small commercial sites are tolerated, and holders must not send unsolicited bulk mail.
Prompted mails only people who subscribed, with one-click unsubscribe, so it fits. eu.org gives no support
and no promised approval time.

### 6a. Add the domain to Cloudflare (owner) — DONE November 11

Cloudflare accepted `prompted.eu.org` on the Free plan with no DNS records. It is "pending" there until
eu.org approves the name. Assigned name servers (not secret): `alfred.ns.cloudflare.com` and
`olga.ns.cloudflare.com`. If Cloudflare ever drops the pending domain and it has to be added again, the
name servers may change, and the eu.org record must then be updated to match.

Claude's access token may not add domains, so this is an owner step.

1. https://dash.cloudflare.com, account home, **Add a domain** (or **Onboard a domain**).
2. Enter `prompted.eu.org`. If offered, choose **Manually enter DNS records**. Continue.
3. Choose the **Free** plan. Skip the DNS records page.
4. Cloudflare shows two name servers ending in `.ns.cloudflare.com`. Give both names to Claude.
   If Cloudflare refuses the name, give Claude the exact message.

### 6b. Request the name at eu.org (owner) — only after 6a

1. Sign in at https://nic.eu.org/arf/ and choose **New domain**.
2. Complete domain name: `prompted.eu.org`.
3. Organization: `Prompted`. Leave the contact as your handle. Fill the address fields with the same
   details as your contact.
4. Under "Check for correctness of", choose **server names** (the lightest check; Cloudflare does not
   answer for the name until eu.org has approved it).
5. In "Name servers", put the first Cloudflare name in **Name1** and the second in **Name2**. Leave the IP
   boxes empty.
6. Submit. A page of green "OK" lines means the request is queued. Approval arrives by email and can take
   days or longer.

### 6c. After approval (Claude, with two small owner steps)

1. Cloudflare shows the domain as **Active**.
2. Owner widens the API token so Claude can manage the domain's records: Cloudflare, **My Profile**,
   **API Tokens**, edit the existing token, add **Zone / DNS / Edit**, **Zone / Zone / Read** and
   **Zone / Email Routing Rules / Edit** for the zone `prompted.eu.org`. Nothing else changes.
3. Claude moves the site onto the domain (one setting in `wrangler.toml`), so email links and the sender
   address share one domain.
4. Owner creates a free Brevo account at https://www.brevo.com with the Prompted Google account, adds
   `prompted.eu.org` as a sending domain, and asks Brevo support to enable sending through the API,
   saying plainly that it is a weekly newsletter to people who subscribed, sent from our own software.
   (Brevo's own page says activation is requested from support and that the purpose must be stated.)
5. Claude adds the DNS records Brevo shows (a verification code, two DKIM records, a DMARC record) and
   turns on Cloudflare's free email forwarding so replies to the domain reach the owner.
6. The dashboard's **Check a sending domain** must say Ready before any test is sent.
7. Owner stores the Brevo API key in Cloudflare as the secret `BREVO_API_KEY`, and `FROM_EMAIL`
   (for example `brief@prompted.eu.org`) the same way.
8. Seed tests, each one approved by the owner, recorded under **Where test emails landed**.

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
