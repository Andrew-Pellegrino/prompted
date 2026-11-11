# Domain options and recommendation

Written November 2026. **Nothing has been bought and the domain strategy has not been changed.** The owner
has said a small domain cost (roughly $5, a little more for a good reason) is now acceptable, and that any
purchase needs explicit approval first.

Prices below come from third-party price trackers and comparison sites read in November 2026. They move.
Confirm the figure at the registrar's checkout before paying.

## Where eu.org stands

- Two submissions (iPhone, then Brave on Windows) both came back to a blank form. The file the iPhone saved
  as `document.txt` is that same blank form, not a result page.
- eu.org's published software returns a plain-text result page for every submission that is accepted for
  checking. Neither attempt produced one, on two devices and two browsers. That points at the site, not at
  the owner's browser.
- A forum post from April 2026 claims eu.org had stopped taking new registrations. Unconfirmed, but
  consistent with what happened.
- There is no page where an ordinary user can see pending requests, so "is anything pending?" cannot be
  answered from outside.
- Even if a request did go through: approval has no timetable, and the `eu.org` name space is also used for
  throwaway addresses, so some mail filters may distrust it.

**Assessment: not worth more of the owner's time.** One last attempt is possible (steps at the end), but it
is optional and should not hold anything up.

## Options compared

| | Free: eu.org | Paid: `.com` or `.org` at Cloudflare Registrar | Paid: `.com` at a discount registrar (Spaceship, Porkbun, Namecheap) | Paid: very cheap endings (`.xyz`, `.online`, `.site`, `.top`) |
| --- | --- | --- | --- | --- |
| First year | $0 | `.com` about $10.46; `.org` about $8.50 | About $3 to $10 with a promotion | About $1 to $3 |
| Each later year | $0 | `.com` about $10.46; `.org` about $11.20 (sold at cost, no mark-up) | About $10 to $15, varies by registrar | Often $12 to $30: the low price is first-year only |
| Registering | Has failed twice, no feedback | A few minutes, inside the Cloudflare account already in use. Needs a payment card added to that account | A few minutes, new account at that registrar | A few minutes |
| Cloudflare set-up | Two name servers, after approval | Nothing to do: the domain is already in Cloudflare | Enter two name servers once | Enter two name servers once |
| Works with Brevo and Resend | Yes in principle | Yes | Yes | Yes |
| Starting reputation | None, in a name space some filters distrust | None, in the most trusted name spaces | Same as the Cloudflare column | None, in name spaces heavily used for spam; several filters score them down |
| Ownership | Held at eu.org's discretion, no support | Owner's, renewable indefinitely, transferable, free privacy for the owner's details | Same, privacy usually free | Same, but reputation follows the ending |
| Verdict | Stop | **Recommended** | Fine if saving a few dollars in year one matters more than having one account | Not recommended for email |

The prices and reputation notes for the very cheap endings are general knowledge and were not re-checked
this month.

A US-specific ending (`.us`, about $6.50 a year) was considered and set aside: its registry does not allow
the owner's name and address to be hidden in the public record.

## What a paid domain does and does not fix

It fixes: the approval wait, the uncertainty, and the "free name space" suspicion. It gives Prompted an
identity it owns for as long as it renews.

It does not fix: reputation. A new domain starts with none. The warm-up plan in `DELIVERABILITY.md` (seed
tests, announcing the new address from beehiiv, staged sends over about four weeks) applies unchanged.

## Names that were unregistered when checked (November 2026, public registry lookup)

| Name | Note |
| --- | --- |
| `readprompted.org` | Matches what readers already see: the beehiiv site, the current sender name, the Gmail account and the preview address all use "readprompted" |
| `readprompted.net` | Same handle, less familiar ending |
| `promptedbrief.com` | A `.com`, at the cost of a new name readers have not seen |
| `promptedweekly.com` | Same trade-off |

`readprompted.com`, `getprompted.com` and `promptedai.com` are already registered by others.
Availability can change at any moment; the registrar's search is the final word.

## Recommendation

**Register `readprompted.org` at Cloudflare Registrar** (about $8.50 for the first year, about $11.20 a year
after). Reasons: readers already associate "readprompted" with the newsletter, `.org` is a trusted ending
that suits a brief prepared for an institute, the price does not jump at renewal, and the domain lands in
the Cloudflare account that already runs the site, so there is nothing to connect.

If a `.com` is preferred, `promptedbrief.com` at about $10.46 a year flat is the alternative.

One thing to know before buying at Cloudflare: it means adding a payment card to the Cloudflare account
that runs the preview. That does not change the free Workers and database plan and nothing else is
charged, but it does end the "no payment method on file" state. Buying at a separate registrar keeps
Cloudflare card-free at the cost of a second account and one extra step.

## What changes in the platform when a domain is chosen

Small and contained. Verified by an automated test that rebuilds the whole site for a different address
and finds no trace of the old one.

1. `SITE_URL` in `platform/wrangler.toml`, and the one `routes` line there.
2. Worker secret `FROM_EMAIL` (for example `brief@<domain>`), later `BREVO_API_KEY`.
3. DNS records for Brevo (verification, DKIM, DMARC) and free email forwarding for replies.
4. The Google sign-in redirect address, only if Gmail stays connected as a fallback.

The archive, database, dashboard, tests and the preview address all stay as they are. The preview keeps
working throughout.

## Optional: one last eu.org attempt that captures the real response

Only if the owner wants a definite answer. About five minutes.

1. Open **Microsoft Edge** (no content blocking). Sign in at https://nic.eu.org/arf/ and open **New domain**.
2. Press **F12**, click the **Network** tab, and tick **Preserve log**.
3. Fill the form as before and click **Submit**.
4. In the Network list click the first entry named `new/` whose Method is **POST**.
5. Report three things: the **Status Code**, the **Content-Type** under Response Headers, and the first
   few lines of the **Response** tab.

A status of 200 with content type `text/plain` and a line starting `Saved as request` means it worked.
Anything else means eu.org is not accepting the request, and that is the end of that route.
