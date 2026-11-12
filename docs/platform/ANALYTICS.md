# Newsletter analytics (first-party)

Decided by the owner on November 12, 2026: Prompted measures opens and clicks with its **own** tracking on
`readprompted.org`. Amazon SES's open and click tracking (and VDM engagement tracking) is turned off by
the owner, because it would add a second pixel and route every link through an Amazon address. SES's
delivery, bounce, complaint, reject, delay, rendering-failure and subscription reports stay on.

**Current state: built, tested, deployed, and switched off** (`TRACK_OPENS` and `TRACK_CLICKS` are
`"false"`). It stays off for real sending until the owner authorises the inbox-placement tests.

## What is measured

| Measure | Raw | Estimated human |
| --- | --- | --- |
| People who opened, open rate | yes | yes |
| Opens, all | yes | not estimated |
| People who clicked, click rate | yes | yes |
| Clicks, all | yes | yes |
| Click-to-open rate | | yes |
| Clicks per link, with labels (link text, template links, Index terms) | yes | people per link |
| Rates by group: type of address (Miami, other university, personal, other), tag, organization | yes | yes |
| Trend by issue | yes | yes |

Groups with fewer than 5 recipients are not broken out. Reports never show addresses or tracking ids.
The private subscriber record in the dashboard shows that person's raw opens and clicks per issue (for
delivery questions); that view is owner-only.

## How "estimated human" is decided (`src/worker/engagement.mjs`, `HUMAN_RULES`)

- **Opens** count when they come from a browser or mail app, or through Gmail's or Outlook's image proxy
  (those fetch when a reader opens), and at least 15 seconds after sending. Apple Mail Privacy Protection
  preloads (Apple's network), security scanners, scripts and HEAD requests are excluded.
- **Clicks** count when they come from a browser, at least 15 seconds after sending, and not as part of a
  burst in which the same email had 3 or more different links opened within 10 seconds (what link
  scanners do). Clicks from Microsoft's network are treated as checks (Defender Safe Links).
- A likely-human click also counts as a likely-human open.

This is a heuristic. It will miss some readers (images blocked, privacy relays) and count some machines.
The dashboard always shows it next to the raw figures, labelled as an estimate.

## Privacy

- Tracking URLs are `/o/<id>.gif` and `/r/<id>/<link number>`. The id is random (96 bits), different for
  every reader and every issue, and is not the subscriber token: it cannot unsubscribe anyone, reveals
  nothing about the reader and cannot link one issue to another.
- The unsubscribe link and the List-Unsubscribe header go straight to `/u/<token>`, never through tracking.
- Each event stores only time, link number and a coarse requester class. No IP address, no raw browser
  string. The plain-text part of the email has no tracking.
- Retention: detailed events 90 days (`EVENT_RETENTION_DAYS`), after which the send's report is saved
  and the events deleted; per-reader counters cleared after 400 days (`RECIPIENT_ENGAGEMENT_DAYS`).
- Public privacy page (`/privacy/`) explains all of this in plain language.

## Reliability and safety

- A click is forwarded only to a URL stored for that send from the approved issue and template, and only
  if it is an `http(s)` address. Unknown ids or link numbers go to the home page. A destination in the
  query string is ignored. There is no open redirect.
- If recording fails, the reader is still forwarded and the image still loads. If the database cannot be
  read at all, the reader lands on the archive instead of an error.
- Links in emails sent before tracking ids still forward and record nothing.
- A single email can record at most 60 opens and 60 clicks (scanner floods).

## The optional "In the Prompted Index" block

Off (`INDEX_TERMS_EMAIL = ""`). Not adopted; shown to the owner for a decision. When used, it adds a
small labelled line of up to five Index term names under the sign-off, each linking to its Index entry
(and tracked per term). Terms are picked from the issue's own text: mentioned more than once if possible,
favouring terms that are distinctive to the issue. It adds no words to and changes nothing in the
editorial text (tested byte for byte). Preview it in the dashboard (Publish, the checkbox above the email
preview) or with `INDEX_TERMS_EMAIL = "preview"` in test sends.

## Turning tracking on (owner's decision, not yet given)

1. Seed round without tracking (approved sends to the seed inboxes, including Miami addresses).
2. The same seed with `TRACK_OPENS` and `TRACK_CLICKS` set to `"true"`.
3. If placement holds, keep it on for real sends; if not, compare and decide.
