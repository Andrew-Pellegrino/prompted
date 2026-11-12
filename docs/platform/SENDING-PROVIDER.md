# Which service sends the newsletter (decision record, November 12, 2026)

**Recommendation: Amazon SES as the main sender, Brevo's free plan for tests and as the fallback, Gmail as
the last resort.** Waiting for the owner's approval before an AWS account is opened. Nothing paid has
been activated.

## Why the plan changed

Brevo's free plan sends 300 emails a day. The list is about 255 people and growing, and every subscriber
must get the issue on Monday morning. The owner is willing to pay a small recurring amount for sending.

## What Amazon SES costs (from Amazon's own pricing page, read November 12, 2026)

- New SES accounts start on the "Essentials" plan: **$0.16 per 1,000 emails**, no monthly fee, no minimum.
  It can be switched to "à la carte" pricing at **$0.10 per 1,000** at any time (the difference is a
  deliverability dashboard that Essentials includes).
- New AWS customers get up to $200 of credits that also cover SES, usable for up to 12 months.
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
  account, and the platform's own daily limit (`SES_DAILY_LIMIT`) stays at 190 until then.
- Amazon reviews or pauses accounts with high bounce or complaint rates, so the platform suppresses hard
  bounces and complaints automatically (already built).

## How fast a Monday send goes out

The platform sends in small batches once a minute, because Cloudflare's free plan allows 50 outside
requests per run.

| Setup | Speed | 255 people | 1,000 | 2,500 |
| --- | --- | --- | --- | --- |
| SES on the free Cloudflare plan (built now) | 30 a minute | 9 min | 34 min | 84 min |
| SES bulk requests, 50 people per request, free Cloudflare plan (to build after the first real SES test) | estimated 500 a minute or more | 1 min | 2 min | 5 min |
| Cloudflare Workers Paid, $5 a month | limited only by Amazon's rate | about 1 min | a few min | a few min |

So the current build covers today's list in under ten minutes from 8:45 a.m. The bulk method (or, failing
that, the $5 Cloudflare plan) is needed before the list passes roughly 1,000. No Cloudflare spending is
proposed now.

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
`ses, brevo, resend, gmail`; a provider is skipped until its credentials exist, so Brevo sends today and
SES takes over when its keys are stored. Unsubscribe links, the one-click unsubscribe header, the
suppression list and the warm-up cap work the same with every provider.

## Setup once approved (owner steps marked)

1. **Owner:** create the AWS account (paid plan, so it is not closed after six months; credits still
   apply) and protect it with two-step sign-in.
2. **Owner:** in SES, region US East (N. Virginia), add `readprompted.org` as an identity with a custom
   "MAIL FROM" subdomain. Amazon shows three DKIM records and two MAIL FROM records. They are not secret.
3. Claude adds those records to DNS. They sit on their own names, so the existing SPF and DMARC records
   stay single.
4. **Owner:** request production access with the text Claude drafts.
5. **Owner:** create a restricted access key (send-only) and store it in Cloudflare as the secrets
   `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`.
6. Bounce and complaint reports: a configuration set and an SNS topic that posts to
   `/api/hooks/ses?key=<webhook secret>`. The platform confirms the subscription by itself.
7. Seed tests, each approved by the owner, then the staged warm-up in `DELIVERABILITY.md`.

## What is built and what is not proven

- Built and tested with simulated Amazon answers: request signing (checked against Amazon's published
  example), the send call with unsubscribe headers, rate-limit and bad-key handling, the status panel, and
  the bounce and complaint reader including the subscription handshake.
- Not proven: anything against the real Amazon service. Expect small fixes on first contact.
- Not built: the bulk method (50 people per request).
