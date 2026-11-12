# Which service sends the newsletter (decision record, updated November 12, 2026, evening)

**Decision: Amazon SES as the main sender, Brevo's free plan for tests and as the fallback, Gmail as
the last resort.** Approved by the owner on November 12.

## Where it stands (read from the real AWS account through the dashboard, November 12)

| Item | State | How we know |
| --- | --- | --- |
| AWS account | Paid plan, root passkey, no root keys, $5 budget alert (an alert, not a cap) | Owner |
| Domain `readprompted.org` | Verified; DKIM and MAIL FROM (`bounce.readprompted.org`) successful | SES API, live |
| Production access | **Not granted.** Under review since November 12; Amazon answers within 96 hours | SES API: sandbox, 200 a day, 1 a second |
| IAM key `prompted-ses-sender` | Works for read-only calls (account, identity, configuration set) | SES API, live |
| Configuration set `prompted-newsletter` | Exists; it is the domain's default | SES API, live |
| Auto Validation | **Off** at account level, no override on the configuration set | SES API, live |
| Amazon's own suppression list | Bounces and complaints | SES API, live |
| SNS topic `prompted-ses-events` | Pinned in the Worker (secret `SES_TOPIC_ARN`). HTTPS subscription created by the owner and **confirmed automatically at 19:54 UTC on November 12** after the platform verified Amazon's real signature. One signed plain-text setup notice received since | Dashboard, audit log |
| Platform use of SES | **None.** SES stays out of the sender chain until production access is granted | Code and live check |
| Real emails sent by the platform through SES | None | Usage counters |

Amazon's counter showed one message sent in the previous 24 hours. The platform did not send it; it is
most likely from the owner's console setup. Worth a glance in the SES console if unsure.

## Why the plan changed

Brevo's free plan sends 300 emails a day. The list is about 255 people and growing, and every subscriber
must get the issue on Monday morning. The owner is willing to pay a small recurring amount for sending.

## What Amazon SES costs (from Amazon's own pricing page, read November 12, 2026)

- New SES accounts start on the "Essentials" plan: **$0.16 per 1,000 emails**, no monthly fee, no minimum.
  It can be switched to "à la carte" pricing at **$0.10 per 1,000** at any time (the difference is a
  deliverability dashboard that Essentials includes).
- New AWS customers get $100 of credits at sign-up and up to $100 more for completing onboarding activities
  (so up to $200, not automatically). They also cover SES.
- Optional extras we do not need and will leave off: dedicated IP addresses ($24.95 a month each or $15 a
  month managed), the global deliverability add-on ($1,250 a month).
- Bounce and complaint reports travel through Amazon's notification service (SNS). At our volume that is
  expected to cost nothing; treat as unconfirmed until the first bill.

| Subscribers | Emails a month (weekly issue) | Essentials ($0.16) | À la carte ($0.10) |
| --- | --- | --- | --- |
| 255 | about 1,100 | $0.18 | $0.11 |
| 1,000 | about 4,350 | $0.70 | $0.44 |
| 2,500 | about 10,900 | $1.74 | $1.09 |
| 10,000 | about 43,500 | $6.96 | $4.35 |

## Limits, stated honestly

- **A new SES account starts restricted** ("sandbox"): 200 emails a day, one a second, and only to
  addresses we have verified. To mail subscribers we must request "production access". Amazon says it
  gives a first answer within 96 hours. **Approval is not guaranteed**, and new accounts are sometimes
  refused or asked for more detail.
- **After approval the daily amount and the per-second rate are set by Amazon for our case.** Amazon's
  documentation gives no fixed number. Commonly reported starting figures are 50,000 a day and 14 a second;
  that is not from Amazon's documentation. The dashboard's SES panel reads the real numbers from the
  account every 30 minutes, and the platform's own daily limit is 90% of Amazon's (or `SES_DAILY_LIMIT`).
- Amazon reviews or pauses accounts with high bounce or complaint rates, so the platform suppresses hard
  bounces and complaints automatically (already built).

## Auto Validation (must be off, or overridden, before any real send)

Amazon SES has a feature called Auto Validation (launched December 2025). When it is on, Amazon guesses
before each send whether the address is likely to deliver, and silently does not send to addresses below
its threshold. From Amazon's documentation:

- The held message is reported as a **Bounce** with type `Permanent` and subtype
  `EmailValidationSuppressed`, although no mailbox refused anything.
- "Suppressed sends still count towards your daily send quota and you will still be charged the standard
  outgoing message fee for suppressed sends in addition to the fee for auto validation."

Why it matters for us: software that treats every "Permanent bounce" as a dead address would permanently
remove a real, confirmed subscriber because of a guess. The same shape is used when an address is on
Amazon's own account suppression list (`OnAccountSuppressionList`, `Suppressed`).

What the platform does (built and tested with simulated reports):

- These reports become `held`, not `bounce_hard`. The message is shown as not delivered with the reason;
  **the subscriber is not unsubscribed, not suppressed and not changed.** The owner reviews them.
- Real hard bounces (`General`, `NoEmail`) and real complaints still suppress permanently.
- The dashboard's SES panel reads the Auto Validation setting from the account and from the configuration
  set, shows it, and does not report "ready" while it is on. Setting `SES_ALLOW_AUTO_VALIDATION = "true"`
  overrides that if the owner ever wants the feature.

Setting: **off** (owner turned it off on November 12; confirmed through the SES API). Reasons: held
messages are still billed, Amazon's guess can hold back a real reader, and the platform already removes
addresses for good after a real hard bounce or complaint. This does not assume the list is clean: people
who joined on the new site confirm by double opt-in, but the existing subscribers came from beehiiv
signups and earlier imports, so their addresses have not all been confirmed that way. The first sends to
the existing list must therefore be staged (see `DELIVERABILITY.md`) so a run of bad addresses shows up
early and small.

## How fast a Monday send goes out

The platform sends from Cloudflare's cron, once a minute. Two limits decide the pace: Amazon's per-second
rate (unknown until production access; commonly 14 a second at the start, not guaranteed) and Cloudflare's
processor time per run (about 10 ms on the free plan, 30 seconds on Workers Paid).

Measured on this code with the largest issue so far (about 60 KB of email): one bulk request costs about
1.2 ms of processor time (the issue is serialised and signed each time), and a run costs about 4 ms
before it does anything. Bulk mode puts up to one second's worth of people in each request (14 at 14 a
second, never more than 50) and spaces requests to stay at 90% of Amazon's rate.

| Setup | Pace | 255 | 1,000 | 2,500 | 10,000 |
| --- | --- | --- | --- | --- | --- |
| One request per person (today's default, `SES_BULK` off) | 10 a minute | 26 min | 100 min | 4 h 10 min | too slow |
| Bulk, free Cloudflare plan (4 requests a run, at 14 a second) | 56 a minute | 5 min | 18 min | 45 min | 3 h |
| Bulk, Workers Paid ($5 a month, 40 requests a run, at 14 a second) | about 560 a minute | 1 min | 2 min | 5 min | 18 min |
| Bulk, Workers Paid, if Amazon grants 50 a second | about 2,000 a minute | 1 min | 1 min | 2 min | 5 min |

Conclusions:

- **Bulk mode is required before cutover.** It needs one more permission on the IAM key
  (`ses:SendBulkEmail`); until then `SES_BULK` stays off.
- **Free Cloudflare plan:** the whole list goes out within an hour up to about 3,000 subscribers.
- **Past that, Workers Paid ($5 a month) is the clean answer** and gives large headroom. It is a new
  charge and needs the owner's approval; it is not needed for the current list.
- Real numbers can only be confirmed after production access, with an owner-approved staged send.

## Alternatives considered

| Option | Cost for our volume | Verdict |
| --- | --- | --- |
| **Amazon SES** | $0.18 to $1.74 a month up to 2,500 subscribers | **Recommended.** Cheapest by far, scales to any size we will reach, strong reputation. Needs approval and more setup |
| Brevo Starter | Reported at $9 a month for 5,000 emails, about $17 for 10,000, $29 for 20,000 (third-party figures; Brevo's own page could not be read by machine, so check it in the Brevo account) | **Best fallback.** Already connected and authenticated; upgrading needs no code. Use if Amazon refuses |
| SMTP2GO | $10 a month for 10,000 (their pricing page) | Reasonable; needs a small new adapter |
| Postmark | $15 a month for 10,000; newsletters allowed on a separate stream | Excellent delivery, pricier |
| Mailgun | $15 a month for 10,000 | No advantage over the above |
| Resend | $20 a month for 50,000 through the API; its newsletter product is priced by contacts ($40 a month for 5,000) | No advantage |
| MailerSend | $7 a month for 5,000, then $1.50 per 1,000 | Small, more expensive per email |
| Cloudflare Email Service | Needs Workers Paid ($5 a month), then $0.35 per 1,000 | **Not suitable now:** described by Cloudflare as transactional (account emails, alerts), in beta, with "a conservative daily quota" for new accounts |
| Gmail account | Free, about 400 a day | Fallback only; landed in Spam in tests |

## What does not change

The website, archive, database, dashboard, domain and Brevo connection stay exactly as they are. SES is one
more adapter behind the same interface (`platform/src/worker/ses.mjs`). The provider order is
`ses, brevo, resend, gmail`; a provider is skipped until its credentials exist, so Brevo sends tests today and
SES joins the chain only once Amazon grants production access (the platform reads that from the account). Unsubscribe links, the one-click unsubscribe header, the
suppression list and the warm-up cap work the same with every provider.

## Setup steps

1. DONE. AWS account (paid plan, passkey, budget alert).
2. DONE. `readprompted.org` identity with MAIL FROM `bounce.readprompted.org`; five DNS records added.
3. DONE. Production access requested (Marketing, `https://readprompted.org/`). **Under review.**
4. DONE. IAM user `prompted-ses-sender` with a restricted policy; key stored as Worker secrets; read-only
   calls verified live.
5. DONE. Configuration set `prompted-newsletter` (domain default), event destination to SNS topic
   `prompted-ses-events`, all ten event types. Auto Validation off.
6. DONE by Claude. Topic pinned in the Worker (`SES_TOPIC_ARN`); signed-report endpoint deployed.
7. DONE. HTTPS subscription added by the owner; confirmed automatically by the platform.
8. DONE. Amazon's own open and click tracking is off: VDM engagement tracking confirmed **off** through
   the SES API (November 12); Opens and Clicks unticked on the event destination by the owner (not readable
   with the key, but the dashboard warns if Amazon ever reports opens or clicks). Prompted uses its own
   (`ANALYTICS.md`).
9. **Owner, before cutover:** add `ses:SendBulkEmail` to the IAM policy; then Claude turns `SES_BULK` on.
10. After production access: seed tests, each approved by the owner, then the staged warm-up in
    `DELIVERABILITY.md`.

## Event reports: how they are trusted and what each one does

The SNS subscription address is `https://readprompted.org/api/hooks/ses`. It contains no secret.
Instead every message is checked: it must name our topic, its signing certificate must come from
`https://sns.<region>.amazonaws.com/...pem`, Amazon's RSA signature must be valid (version 1 SHA-1 or
version 2 SHA-256), the timestamp must be within six hours, and each message id is processed once
(`webhook_messages` table). The subscription handshake is confirmed only for our topic and only by
calling Amazon's own SNS host. Brevo's address and its shared secret are unchanged.

| Amazon event | Platform effect |
| --- | --- |
| Bounce, permanent (General, NoEmail) | Person marked bounced and suppressed for good |
| Bounce, transient | Recorded only |
| Bounce or Complaint caused by Amazon's own list or Auto Validation | **Held**: message marked not delivered, person unchanged |
| Complaint | Person marked complained and suppressed for good |
| Delivery | Message marked delivered (receiving server accepted it; not proof of the inbox) |
| DeliveryDelay | Recorded only |
| Reject, Rendering Failure | Message marked not delivered with Amazon's reason, person unchanged |
| Subscription (unsubscribe from everything) | Person unsubscribed |
| Send | Ignored (already known) |
| Open, Click | Ignored; the dashboard warns, because these mean Amazon is rewriting links and adding a pixel |

## What is built and what is not proven

- Verified live (read-only): the IAM key, domain state, configuration set, Auto Validation setting,
  sandbox limits, the SNS address refusing unsigned and forged messages.
- Tested with simulated Amazon answers only: single and bulk sending, per-person unsubscribe links and
  headers in bulk, throttling and rejection handling, SNS signature checking (with a locally generated
  certificate), every event type.
- Verified live: a real Amazon-signed SNS message (the subscription confirmation) passed the signature,
  topic and certificate checks.
- Not proven: a real send through SES, a real bounce or complaint report, Amazon's real production limits,
  inbox placement.
