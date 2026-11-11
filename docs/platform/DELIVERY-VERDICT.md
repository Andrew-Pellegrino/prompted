# Email delivery at $0: verdict

Checked November 10–11, 2026. Figures marked (official) come from the provider's own pages or documentation;
figures marked (third-party) come from review sites and must be re-checked in the account before relying on them.

## Verdict in four sentences

Independent sending at $0 is achievable for Prompted's current audience, and beehiiv is not needed for it.
The one real prerequisite is a **sender identity the owner controls**: either a free domain, or a Google
account used through the Gmail API. Running our own mail server is not viable at $0. Free tiers stay
comfortable to roughly 400–800 subscribers; beyond that a $0 send spreads over more than one day, or costs
cents per month on a pay-as-you-go provider.

## Audience this was sized for

About 255 active subscribers on beehiiv as of November 11, 2026 (live count; the roster import completed).
One weekly send, plus confirmation emails for new signups and a handful of test sends.

## The sender identity is the crux

Gmail, Yahoo and Microsoft require mail to be authenticated (SPF or DKIM) as the domain in the From address.
We cannot authenticate a domain we do not own: `gmail.com`, `github.io`, `workers.dev` and `miamioh.edu` are
all out for that reason, and the owner has also ruled out any university-controlled resource.

| Option | Cost | Owner-controlled, non-university | Status |
| --- | --- | --- | --- |
| A. Free `eu.org` subdomain (e.g. `prompted.eu.org`) with DNS on Cloudflare | $0 | Yes | Viable. Run by a nonprofit since 1996. Approval time is unpredictable: 2026 reports range from days to never (third-party forum). Apply now, in parallel. |
| B. Gmail API from a dedicated Google account the owner creates | $0 | Yes | Viable today, no domain needed. Google signs mail for its own address. From address is `@gmail.com`. About 500 recipients per rolling day (third-party; Google says limits can change). |
| C. A paid domain (about $10–12 a year) | Not $0 | Yes | Excluded by the spending rule. Noted because it is the single purchase that removes the most fragility. |
| D. Provider's shared domain | $0 | No | Brevo rewrites the From address to `@brevosend.com` when there is no authenticated domain and calls this a temporary stopgap (official). Not a foundation. |
| E. University subdomain or mailbox, GitHub Student Pack domain | — | No | Ruled out by the owner: must survive graduation. |

## Sending providers (need option A, except Gmail)

| Provider | Free allowance | Fit |
| --- | --- | --- |
| Brevo | 300 emails/day, no expiry, API and webhooks included (official) | Primary once a domain exists. One day covers 255 with little headroom. |
| Resend | 100/day, 3,000/month (official) | Overflow only. |
| Gmail API | about 500 recipients/day on a consumer account (third-party) | Works without a domain. Not designed for bulk mail; keep volume modest and complaints near zero. |
| Amazon SES | No permanent free tier; about $0.10 per 1,000 (third-party summaries of AWS pricing) | Not $0. About 11 cents a month at this size. The realistic scale path if the rule is ever relaxed. |
| Cloudflare Email Service | Arbitrary recipients need the paid Workers plan (official docs via search) | Not $0. |
| Sender.net, EmailOctopus | 2,500 subscribers free (third-party) | Hosted newsletter tools, not send APIs. Using them means another platform, not ours. |
| SendGrid, Mailgun, Postmark, Mailjet | Trial only, or 100–200/day | Too small. |

## Growth

The platform enforces each provider's daily cap, keeps a reserve for confirmations, and continues a send the
next day if the cap is reached. It never over-sends and never sends twice (tested).

| Active subscribers | $0 behaviour |
| --- | --- |
| up to about 290 | One provider (Brevo or Gmail), all delivered Monday morning. |
| about 290–780 | Brevo, then Resend, then Gmail in the same morning. Readers may see two different From addresses. |
| above about 780 | The remainder goes out Tuesday. Or accept a cents-per-month provider. |

## Is a personal Gmail account good enough to be the permanent sender?

Short answer: **good enough to start and to prove independence, not good enough to be the only long-term
plan.** It is a bridge. The durable setup is our own free domain with Brevo and Resend, with Gmail kept as
a fallback.

What is in its favour

- It needs no domain. Google signs the mail for its own address, so authentication passes by construction.
- Most current subscribers are on Google-hosted mail, where mail from a Gmail account is treated normally.
- The published figure for personal accounts is about 500 recipients per rolling 24 hours (third-party
  sources agree; Google's own page says limits can change without notice). The current list of about 255
  fits, with the platform capped at 400 a day for margin.
- Google's "bulk sender" rules start near 5,000 messages a day to Gmail addresses (official FAQ). Prompted
  is far below that.

What counts against it

- **Hard ceiling.** About 400 usable recipients a day. Past that, a send spills into the next day.
- **Per-minute pacing.** New Google Cloud projects get 6,000 Gmail API quota units a minute per user and a
  send costs 100 (official quota page), so at most 60 sends a minute. The platform sends 20 a minute:
  255 recipients take about 13 minutes.
- **It is a personal mailbox, not a mailing service.** Google does not promise it for newsletters, gives
  no delivery reports, and can rate-limit or lock an account that draws spam complaints, with no support
  channel. One lockout stops the newsletter until Google lifts it.
- **Sign-in fragility.** While the Google app is in "Testing" the connection expires every 7 days
  (multiple sources). Published, it lasts, but Google can still revoke it after a password change or six
  months without use. The platform detects this, pauses the send without losing anyone, and shows
  "Reconnect Gmail" in the dashboard.
- **No bounce reports to the platform.** Bounces arrive as ordinary mail in the sending account's inbox and
  must be marked by hand in the dashboard. Reading them automatically needs a much more sensitive Google
  permission, which was deliberately not requested.
- **The From address is `@gmail.com`**, which looks less established than a domain.
- **Unverified in practice:** whether Gmail keeps the one-click unsubscribe header on API-sent mail, and
  inbox versus Promotions placement. Both are on the test list for the first real test sends.

How the platform limits the risk: dry run by default; test inboxes only in the preview; a staged send
(a tagged pilot group first, then "send to everyone not yet included"); automatic pause on any limit or
sign-in problem; a hard rule that nobody is mailed twice.

Decision rule: use Gmail for testing now and, if the tests pass and the owner approves, for the first
independent sends. Move the primary sender to the free domain plus Brevo as soon as the domain is approved.
If the list passes about 350 before that, treat the domain as urgent.

## Self-hosted SMTP: evaluated and rejected

Running our own sending server needs all of the following.

1. **A host that may open outbound port 25.** AWS, Google Cloud, Azure, DigitalOcean and Oracle Cloud all
   restrict outbound port 25 by default (third-party summary of provider policies). Cloudflare Workers cannot
   open port 25 at all (from product knowledge; not re-verified this session). Home internet connections
   usually block it too.
2. **A static IP address with a clean reputation and reverse DNS we control.** Free-tier cloud addresses are
   recycled and widely distrusted. A new address has no reputation; large mailbox providers throttle or junk
   mail from it until it has weeks of clean history.
3. **A sender domain anyway.** SPF, DKIM and DMARC are still required. Self-hosting does not remove the
   domain problem; it adds two more.
4. **Ongoing operations.** Queueing and retries, bounce parsing, blocklist monitoring, TLS certificates,
   security patching.

Conclusion: at $0 there is no host that clears requirement 1 and 2, and it would still need the same domain
as a relay. It is the least reliable route, not the most independent one. No SMTP experiments were run and
nothing was sent to any inbox, because there is no authorised host or domain to test with. The delivery
layer is an adapter (`platform/src/worker/providers.mjs`), so a different sender can be added later without
touching the site, database or CRM.

## Recommended path

1. **Now:** owner creates a dedicated Google account for Prompted and applies for an `eu.org` name
   (steps in `OWNER-SETUP.md`). Both are free and neither involves the university.
2. **Test:** connect the Gmail adapter, send test issues only to the owner's own inboxes, compare with the
   beehiiv email in Gmail, Apple Mail and Outlook.
3. **When the domain is approved:** add Brevo (and Resend) with DKIM on that domain; make it the primary
   From address. Keep Gmail as a fallback.
4. **Cut over** only after the acceptance tests in `CUTOVER-MANIFEST.md` pass and the owner approves.
   beehiiv keeps sending until then.

## What cannot be promised

Inbox placement, identical rendering in every mail client, or that a free tier stays free. Open rates will
not be comparable with beehiiv's figures.

## Sources

- Brevo free plan and sender-domain behaviour: https://www.brevo.com/free-smtp-server/ , https://help.brevo.com/hc/en-us/articles/14925263522578 , https://help.brevo.com/hc/en-us/articles/17286219877778
- Resend free tier: https://resend.com/pricing , https://resend.com/blog/new-free-tier
- Cloudflare free limits and Email Service: https://developers.cloudflare.com/d1/platform/pricing/ , https://developers.cloudflare.com/pages/platform/limits , https://developers.cloudflare.com/email-service/platform/pricing/
- Gmail sending limits: https://knowledge.workspace.google.com/admin/gmail/gmail-sending-limits-in-google-workspace
- Gmail API quota (6,000 units a minute per user, 100 per send): https://developers.google.com/workspace/gmail/api/reference/quota
- Google sender guidelines FAQ (bulk sender threshold): https://support.google.com/a/answer/14229414
- Google OAuth sign-in lifetime in Testing versus published: https://www.unipile.com/google-oauth-refresh-token/ , https://discuss.google.dev/t/oauth2-refresh-token-expiration-and-youtube-api-v3/160874
- Port 25 on cloud hosts: https://cli.nylas.com/guides/smtp-ports-blocked-on-cloud-servers , https://learn.microsoft.com/azure/virtual-network/troubleshoot-outbound-smtp-connectivity
- eu.org: https://nic.eu.org/ , https://forum.infinityfree.com/t/how-to-get-a-free-eu-org-domain/88508
- Amazon SES pricing: https://aws.amazon.com/ses/pricing/
- beehiiv plan limits (API keys on all plans after identity verification; Send API paid): beehiiv support articles read through the beehiiv connector.
