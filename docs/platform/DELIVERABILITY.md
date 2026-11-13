# Deliverability: findings and plan

Written November 11, 2026, after the first real test emails. This supersedes the optimistic parts of
`DELIVERY-VERDICT.md` about Gmail. Delivery (the provider accepts the message) is solved. Inbox placement
(the reader actually sees it) is not, and it is the thing that matters.

## What happened

Three real messages were sent from the dedicated personal Google account through the Gmail API to the
owner's one authorised test inbox. All three were delivered. **Gmail put all three in Spam.** The owner
marked them "Not spam". The sending account's own inbox shows no rejection notices.

| Message | Links | Images | List-Unsubscribe header | Result |
| --- | --- | --- | --- | --- |
| Latest issue as a test | yes (`workers.dev`) | one | yes | Spam |
| Signup confirmation | one (`workers.dev`) | none | no | Spam |
| Plain delivery check | none | none | no | Spam |

## First Amazon SES results at Miami (November 12 to 13)

- Two authorised tests of the latest issue from `brief@readprompted.org` through Amazon SES (tracking off,
  then on) were **accepted by Miami's mail server** (Amazon's signed delivery reports) and authenticated
  cleanly (SPF, DKIM as readprompted.org, DMARC: all pass at a real receiver).
- The owner found both in **Spam** and marked them "Not spam". Gmail's own note on both read "You reported
  this message as spam from your inbox", which normally means a message first landed in the inbox; the
  owner's recollection is that they appeared in Spam. Treat the result as **not yet inbox**.
- No complaint reached Amazon (Google does not send per-message complaints back), so nothing was suppressed.
- Miami's mail shows external images blocked until "Show images" is pressed, so the lockup image appears as
  an empty box at first. The text masthead carries the identity regardless.
- The tracking-on copy recorded an image fetch 5 seconds after delivery while the images were still
  blocked for the reader: Google's systems, not a person. The platform's human estimate excludes it.
- A third test (tracking off) was sent at 7:40 PM ET on November 12, after the "Not spam" marks.

Likely causes, in order: the domain is two days old with no sending history; Amazon's shared sending
addresses; one-off test messages with a "[TEST]" subject. None is a configuration error. What helps, with
no code change needed: a slow warm-up to people who expect the email (already built), readers adding
`brief@readprompted.org` to their contacts (the planned announcement from beehiiv), consistent weekly
volume, and, for Miami specifically, asking Miami IT to treat `readprompted.org` as a trusted sender
(owner's decision; nobody has been contacted). Optional and free: Google Postmaster Tools for
`readprompted.org` shows Gmail's view of the domain's reputation once volume builds (the owner adds the
domain in Postmaster Tools; Claude can add the verification record to DNS).

## Open concern: Miami recipients who say they never saw Prompted (November 12)

Two members of the SEPi group who joined on October 12 told the owner they had not seen Prompted. In
beehiiv, both records are active and all four issues since (October 19 and 26, November 2 and 9) show
**Sent** and **Delivered**, with no bounce. Their recorded opens may come from automated image loading or
security scanners, so they do not prove a person saw the email. "Delivered" means the receiving mail
server accepted the message; it can still be quarantined, filtered, moved or overlooked afterwards. One
of the two checked Spam and found nothing. A follow-up asking for a search of all mail is pending.
Names and addresses are in the owner's private CRM only.

What follows from this:

- It is a **sentinel**, not a measured rate. Two reports do not show that everyone in the group, or every
  Miami address, is affected, and they do not show that nobody else is.
- It concerns the **current beehiiv sends**, so moving to Amazon SES is not, by itself, a fix. The
  receiving side (Miami's Google Workspace filtering, quarantine, or forwarding rules) is as likely a
  cause as anything on the sending side.
- Before cutover, compare groups on evidence that goes beyond "delivered": the whole October SEPi
  cohort (exact membership from the CRM and beehiiv), other Miami groups, other universities and
  non-university addresses. Where nobody can confirm, ask Miami IT for a message trace of a specific
  Monday send. All outreach and any test email need the owner's approval.
- The cutover acceptance list (`CUTOVER-MANIFEST.md`) now includes cross-group inbox placement.

Tracking and Miami: first-party open and click tracking (on `readprompted.org`, see `ANALYTICS.md`) stays
off for the first seed round, which gives a clean placement baseline; the same seed is then repeated with
tracking on, including Miami addresses. Tracking stays on only if placement holds.

What the platform contributes once SES sends: per-recipient delivery, delay, bounce and complaint
reports from Amazon, kept per send and per address, so a group's results can be compared without relying
on open pixels (Amazon's own open and click tracking should stay off).

## What the evidence rules out

The plain message's headers were read in full:

- `spf=pass`, `dkim=pass` (signed by `gmail.com`), `dmarc=pass`. **Authentication is not the cause.**
- The plain message had no links, images, tracking or unsubscribe header and was still filtered.
  **So the newsletter's content, layout, links and unsubscribe handling are not the main cause either.**
- The headers show the message entered through `gmailapi.google.com`, sent by an account created the same
  day with no prior history.

What remains is **sender reputation**: a brand-new account whose first-ever messages are automated. Google
does not publish its reasons, so this is an inference, but it is the only explanation consistent with all
three results, and it matches what deliverability sources describe for new senders.

Not yet checked: whether Gmail kept the `List-Unsubscribe` header on the issue test (the owner can open
that message, choose "Show original", and search for `List-Unsubscribe`), and what the grey banner in the
Spam folder said.

## Why "Not spam" does not settle it

Marking a message "Not spam" mostly teaches that one mailbox. It helps the owner's inbox. It says little
about the roughly 255 other readers, most of whom are on a university Google Workspace with its own filters.

## The options, honestly

No $0 option gives instant inbox placement. Reputation is earned by sending mail people want, consistently,
from an identity that stays the same. The question is which identity is worth building.

| | A. Personal Gmail account | B1. Free `eu.org` domain + Brevo | B2. Paid domain + Brevo |
| --- | --- | --- | --- |
| Cost | $0 | $0 | about $10–12 a year (outside the $0 rule) |
| Authentication | Passes, as `gmail.com` | Passes as our own domain once DNS is set | Same |
| Whose reputation | One consumer account. Cannot be measured or moved | Our domain's. Moves with us between providers | Same |
| Starting reputation | None, and today's result shows it | None: a new domain also needs warming | None, but a normal namespace |
| Known weakness | Built for person-to-person mail. Lockout risk. 400 a day | The `eu.org` namespace is also used for throwaway addresses, so some filters may be wary. Unmeasured. Approval can take days or never come | None specific |
| Feedback | None (no bounce or complaint reports) | Bounce and complaint reports; DMARC reports | Same |
| Capacity | about 400 a day | 300 a day (Brevo), plus 100 (Resend) | Same |
| Shared sending servers | Google's | Brevo's free pool: placement moves with the pool (one blogger measured 86 percent; indicative only) | Same |
| Verdict | Keep as a test tool and fallback. Not the foundation | **The $0 route to try**, but it must prove itself in tests before anything depends on it | The most dependable route. Flagged, not proposed |

Other free hosted newsletter services (Substack, Buttondown, Kit) deliver well because they lend their own
reputation, which is exactly what beehiiv does now. Using one would swap one dependency for another.

**The plain statement:** the $0 rule and the independence goal now pull against inbox reliability. The $0
path (B1) may work, but it is unproven. If B1 tests badly, the choice becomes: keep beehiiv as the sender
for longer, or approve a small yearly domain cost. That is the owner's decision, and it does not need
making until B1 has been tested.

## Plan

Update: the free `eu.org` route has stalled and the owner is open to a low-cost domain. See
`DOMAIN-OPTIONS.md`. The steps below are the same whichever domain is used.

1. **Apply for the free domain now** (owner, `OWNER-SETUP.md` step 6). Nothing else waits on it.
2. **Let the Google account age.** No more automated sends from it for now. Optional and free: reply to the
   delivery check from the test inbox, and answer from the Prompted account, so it has some ordinary
   two-way history. Publish the Google Cloud app so the sign-in stops expiring weekly.
3. **When the domain is approved:**
   - DNS on Cloudflare (free). Move the preview site onto the domain, so links in the email and the sender
     address share one domain instead of pointing at `workers.dev`.
   - Brevo: add the domain, publish SPF, DKIM and a DMARC record (`p=none` with a reporting address).
   - Cloudflare Email Routing (free) so replies and bounce notices to the domain reach the owner.
   - The dashboard's "Check a sending domain" must say Ready.
4. **Seed tests, each with the owner's approval:** the owner's own inboxes at Gmail, Outlook and iCloud,
   plus the owner's university inbox as a recipient, because that is where most readers are.
   Pass mark: inbox, not spam, three tests running at each.
5. **Announce the move from beehiiv first.** Two issues in a row carry one line: "Prompted is moving to a new
   sending address, [address]. Add it to your contacts so issues keep arriving." A trusted sender telling
   readers to expect the new one is the strongest free signal available.
6. **Warm up over about four weeks** using staged sends and the warm-up cap: most engaged readers first
   (about 20), then about 60, then about 150, then everyone. beehiiv keeps sending to everyone not yet
   moved, so nobody misses an issue and nobody gets two. Hold or step back at the first sign of spam
   placement, bounces or complaints.
7. **Full cutover only when** the seed inboxes are clean, delivery is above 95 percent, there are no
   complaints, and unsubscribe works end to end.

## Brevo on the free plan: what is verified and what is not

| Question | Answer | Basis |
| --- | --- | --- |
| Daily limit | 300 emails a day, no expiry | Brevo pricing page |
| Can our own software send a newsletter through its API? | Brevo's own page says API/SMTP sending is activated by asking support and stating whether it is for marketing or transactional mail. So it is allowed when declared, and it is not automatic | Brevo free SMTP page |
| Domain needed | Yes. Without an authenticated domain Brevo rewrites the From address to its own shared domain | Brevo help centre |
| Bounces and complaints | Reported to us by webhook; the platform suppresses the address automatically | Brevo features; platform tests |
| Unsubscribe | Ours: a link in every issue plus the one-click header. Brevo does not add one to API sends | Platform design; to be confirmed in the first approved test |
| Brevo logo in the email | Review sites say free-plan emails carry Brevo branding. Whether that applies to API sends is **not verified** | Third-party reviews |
| Sending servers | Shared with other free senders; placement moves with that pool | Third-party test, indicative |
| Growth | 300 a day covers the list today. Past that the platform adds Resend (100 a day) and then spreads a send over two days | Provider pages; platform tests |

Things that can still go wrong on this route: eu.org never approves the name; Brevo declines to activate
API sending for a new free account; the shared pool or the `eu.org` name space is distrusted by some
filters. Each one is checked before anything depends on it, and beehiiv keeps sending until then.

## What the platform now does to help

- **Warm-up cap** (`WARMUP = "start date,first-day cap,growth"`): real sending is limited per day and the
  limit rises gradually. Nothing real is sent before the start date.
- **Staged sends:** a tagged group first, then "everyone not yet included", never anyone twice.
- **Tracking off by default.** Tracking pixels and redirect links make a new sender look like bulk mail,
  and open counts are unreliable anyway. Unsubscribes, bounces and web visits are still measured.
- **Cleaner email:** no invisible padding characters in the preview line; subject matches the established
  format.
- **Sending-domain check** in the dashboard (Tools): reads SPF, DKIM and DMARC for any domain and says
  what is missing. Verified live against a correctly set-up domain and an empty one.
- **Inbox placement log** in the dashboard (Tools): each test result is recorded by hand, and the gate
  "three inbox results in a row for each kind of inbox" is computed from it. The November 11 Spam result
  is the first entry.
- **Plain delivery check** button, for telling "the account is filtered" apart from "the content is filtered".
- **Gmail sign-in health** shown in the dashboard, with the expiry date while the Google app is in Testing.

## Sources

- New-sender reputation and first-contact filtering: https://suped.com/email-deliverability/answers/why-do-my-first-emails-to-new-gmail-recipients-go-to-spam , https://www.suped.com/learn/email-deliverability/why-does-gmail-mark-emails-from-new-domains-as-spam , https://developer.nylas.com/docs/cookbook/email/email-deliverability/ , https://mailgun.com/blog/deliverability/prevent-gmail-blocking-emails
- Gmail API mail is authenticated normally: https://www.gmass.co/blog/gmail-vs-api-deliverability/
- Brevo free plan, shared servers, warm-up: https://marcandrews.com/brevo-deliverability-uk-2026/ , https://www.brevo.com/blog/how-to-warm-up-email-domain/ , https://www.brevo.com/blog/ip-warming/
- `eu.org` namespace and throwaway addresses: https://www.pulse.bot/cybersecurity/news/you-see-an-email-ending-in-euorg-must-be-legit-right-76d89522-70f1-48a1-8c80-4dd729ecb7bb/
- Google Postmaster Tools coverage and volume: https://www.suped.com/knowledge/email-deliverability/tools/what-email-volume-is-required-to-see-data-in-google-postmaster-tools
