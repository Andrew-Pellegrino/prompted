# Migration report

State on November 11, 2026. "Migrated" means present on `platform-dev` and covered by a passing test.
"Ready" means the importer exists and is tested with synthetic data, but no real data has been loaded.

## Issues: migrated (31 of 31)

- Source: the 31 public web posts on `readprompted.beehiiv.com`, downloaded without credentials.
- Method: `platform/scripts/extract-beehiiv.mjs`. For every issue the script compares all text in the
  source page's content area with the text of the extracted blocks and stops on any difference.
  All 31 passed. A SHA-256 of each issue's text is stored in the file and re-checked by the test suite.
- Preserved: wording, paragraph boundaries, section and story headings, bold and italic, links, the closing
  lines where the source has them, the original week dates, the beehiiv post id and URL.
- Dates kept separate: `week` (the editorial week), `publication` (when it went out) and
  `source.beehiiv_published_at` (when beehiiv recorded it).
- Eight beehiiv drafts (test posts and untitled scratch drafts) were inventoried and not migrated.

| Group | Issues | Publication date used |
| --- | --- | --- |
| Emailed through beehiiv on a Monday at 8:45 a.m. Eastern | 21–31 (11 issues) | beehiiv's send time (verified against post statistics for a sample) |
| Published before beehiiv, back-filled to its archive | 1–20 (20 issues) | The Monday after the week ended, labelled "derived". The true original send times are not in beehiiv. |

Things the owner should know (nothing was changed to "fix" them):

- Issues 1–17 have no closing line on beehiiv, and their "Why This Week Matters" labels vary in format.
  They are reproduced as published.
- Issue 31 contains "948 Linux fla ws" in its opening paragraph on beehiiv. It is preserved verbatim.
  If it is a typo, correct `content/issues/031-…json` by hand and it is fixed on web and email together.
- Only two issues contain links (issue 19 has four, issue 21 has one). No issue links to the Index yet.
- The weekly header PNG is not migrated. The masthead is now live text plus one stable logo image.

## A finding about the reading gate

beehiiv's "gated" posts include the full article text in the page that is sent to every visitor. The gate
is a prompt, not access control. The new site does the same thing openly: a "keep reading" signup prompt
after the opening, with a one-click "I already subscribe" option, and the full text in the page for search
engines and for readers without JavaScript. A truly enforced gate is not possible on a public repository
and would add friction; it can be switched off with `"gate": "off"` in `content/site.json`.

## Prompted Index: integrated, untouched

The build copies `index/` and changes only the subscribe link in the copy. The canonical
`index/data.json` is never written (tested). Issue pages list approved Index terms that appear in the issue
by exact term name; pending terms are never shown. Counts and anchors are unchanged.

## Subscribers and CRM: ready, not loaded

No real subscriber, roster or CRM data has been copied anywhere by this work.

Live beehiiv state read through the connector (counts only):

| When | Active | Inactive | Pending | Needs attention |
| --- | --- | --- | --- | --- |
| Nov 10, about 6:40 p.m. ET | 128 | 5 | 2 | 0 |
| Nov 11 | 255 | not re-read | not re-read | not re-read |

The 127-person roster import that was "Processing" on November 10 has completed on beehiiv's side
(128 new subscribers in the last 7 days, all "import: direct"). It was not re-run or touched.
The corrected and the retired address for the one subscriber with a typo were both verified in their
expected states (one active, one inactive) on November 10.

What the importer does, each point covered by a test with synthetic people:

- Full-ledger mode keeps each person's status, subscribe and unsubscribe dates, source and tags.
- Unsubscribed, bounced and complained addresses go on a permanent suppression list and are never
  re-activated by any import or by the signup form. A returning reader must confirm by email.
- Roster mode adds new people as Prospective by default, keeps "Member LOA" as a flag, records
  organization and role, and marks inferred addresses as inferred.
- Duplicates inside a file and against the database are detected. Re-importing the same file changes nothing.
- Adding anyone as Active requires the owner to tick a consent statement, which is written to the audit log.

## Historical metrics: recoverable, importer ready

Read through the beehiiv connector per post: recipients, delivered, opens, unique opens, clicks, unique
clicks, verified clicks, unsubscribes, spam reports, web views and web clicks. Also available: per-link
clicks, a daily growth series, acquisition sources per subscriber.

Not recoverable from beehiiv: statistics for the 20 issues sent before beehiiv, per-recipient open and click
history in bulk, and anything about emails forwarded by readers.

The values themselves are business data and are not stored in this public repository. The dashboard keeps
beehiiv-era and platform-era figures in separate, labelled rows and never recalculates the imported ones.

## Verification summary

25 automated tests pass (`npm test`). A browser run against the real local Workers runtime exercised:
campaign link, signup, email confirmation, reading gate, archive search, Index link, dashboard login,
CSV import of 40 synthetic people, QA, test send, owner approval, scheduling for Monday 8:45 a.m. Eastern,
and a cron-driven dry-run send to 41 synthetic subscribers with no duplicates.
