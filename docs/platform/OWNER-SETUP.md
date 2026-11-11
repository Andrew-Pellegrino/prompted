# Owner setup steps

Everything here is free and none of it involves Miami University. Do the steps in order; each one says what
it unlocks. Never paste a password, key or token into a chat or a file in this repository.

## 1. Cloudflare account (unlocks the preview site and the private database)

1. Go to https://dash.cloudflare.com/sign-up and create an account with a personal email address.
   Choose the Free plan. Do not add a payment method. If a screen asks for one, stop and tell Claude.
2. In the dashboard open **Workers & Pages**. If asked, pick a `workers.dev` subdomain (for example
   `prompted`). The preview will live at `https://prompted-platform-dev.<that-subdomain>.workers.dev`.
3. Create an API token: profile icon, **My Profile**, **API Tokens**, **Create Token**, template
   **Edit Cloudflare Workers**, then add the permission **Account / D1 / Edit**. Keep the token private.
4. Tell Claude in a Claude Code session that the account exists. Claude will ask for the token through a
   secure form (it never sees the value) and then run:

```bash
npx wrangler d1 create prompted-dev
```

```bash
npx wrangler d1 migrations apply DB --remote
```

```bash
npm run deploy:preview
```

Free limits that apply (official Cloudflare pages): Workers 100,000 requests a day; D1 5 GB, 5 million rows
read and 100,000 rows written a day; static files are not counted. Prompted uses a tiny fraction of this.

## 2. Dashboard password and secrets (unlocks the owner dashboard)

Run this on your own computer or let Claude run it and show you the password once:

```bash
npm run admin-secret
```

Save the password in a password manager. The three values it prints are stored as Worker secrets with
`npx wrangler secret put <NAME>`; they are never committed.

## 3. A sending identity (unlocks real email)

Do both. B works immediately; A is the better long-term address and can take time to be approved.

**A. Free domain from eu.org**

1. Create a contact at https://nic.eu.org/arf/en/contact/create/ with your personal details.
2. Request a name such as `prompted.eu.org`. When it asks for name servers, use the two Cloudflare name
   servers shown after you add the domain to Cloudflare (**Add a site**, enter the name, Free plan).
   If Cloudflare refuses the name until it exists, tell Claude; there is a documented workaround.
3. Wait for the approval email. This can take days or longer. Nothing else is blocked meanwhile.

**B. Dedicated Google account for sending (Gmail API)**

1. Create a new Google account for Prompted (not your university account), for example a
   `readprompted`-style address. Turn on 2-Step Verification.
2. At https://console.cloud.google.com create a project named `Prompted`, enable the **Gmail API**, and
   under **OAuth consent screen** choose **External**, add yourself as a user, then publish the app
   (an unpublished app's sign-in expires after 7 days).
3. Under **Credentials** create an **OAuth client ID** of type **Web application** with the redirect
   address `https://developers.google.com/oauthplayground`.
4. Tell Claude. Claude will walk you through producing a refresh token for the single permission
   `gmail.send` and storing it, with the client ID and secret, as Worker secrets.

**C. Later, when the domain is approved:** create free accounts at https://www.brevo.com and
https://resend.com, add the domain in each, and give Claude the DNS records they show. Claude adds them in
Cloudflare DNS and stores the two API keys as secrets.

## 4. A mailing address for the email footer

US law (CAN-SPAM) requires a physical postal address in every issue. beehiiv has been supplying one.
Decide which address to use (a PO box or a registered-agent address works) and give it to Claude to set as
`POSTAL_ADDRESS`. QA blocks every real send until this is set.

## 5. Authorised test inboxes

Give Claude the addresses that may receive test sends (your own inboxes in Gmail, Outlook and Apple Mail are
ideal). They go in `TEST_RECIPIENTS`. In the preview environment nothing can be sent to anyone else.

## 6. Private data migration (only after 1 and 2 are done and you approve)

1. In beehiiv: **Subscribers**, **Export**, full export including inactive subscribers. Save it to your
   owner-only Drive folder, not to this repository.
2. Open the preview dashboard, **Import**, choose the file, set "Kind of file" to **Full ledger from another
   system**, review the preview, then import. Statuses, dates, sources and suppressions are kept.
3. Export the Contacts tab of the Distribution CRM as CSV and import it as **New contacts** with
   "Add new people as: Prospective". Existing people are enriched, never duplicated or re-activated.
4. Per-issue statistics: Claude reads them through the beehiiv connector and loads them under
   **Tools, Import historical metrics**.
