# Cutover manifest

Nothing in this file has been changed in production. Every row is a planned change that needs the owner's
approval. Until cutover, beehiiv keeps sending and every existing link keeps working.

`NEW` below stands for the platform's production address. It does not exist yet: the preview address is
`https://prompted-platform-dev.readprompted.workers.dev`, and the production address will be either the
free `eu.org` domain or a `workers.dev` address.

## Go / no-go: current answer is NO-GO

| Acceptance test | State |
| --- | --- |
| Site, archive, Index copy and signup work in a deployed preview | **Passed** on the preview, November 11 (synthetic data). |
| Private database deployed with dashboard login | **Passed**: anonymous, forged and cross-site requests are refused. |
| Real subscriber ledger imported and reconciled against beehiiv counts | Not started (needs the deployed database and owner approval). |
| A sending identity exists and passes SPF/DKIM/DMARC checks | Gmail account connected and authenticating, but its mail lands in Spam. A dedicated domain is the plan (`DELIVERABILITY.md`). |
| Test issues reach the inbox (not Spam) at Gmail, Outlook, iCloud and a university inbox, three times running | **Failed** on the first attempt from the Gmail account (Spam). |
| New sending address announced to readers from beehiiv in two issues | Not started. |
| Warm-up completed with staged sends while beehiiv covers the rest | Not started. |
| Test issue received and compared in Gmail, Outlook and Apple Mail | Not started. |
| Postal address set in the footer | Not set. QA blocks real sends until it is. |
| One full dry run of a Monday send against the real ledger | Not started. |
| Rollback rehearsed | Plan below; not rehearsed. |

## Links and integrations

| # | Today | Planned | Owner of the change | Prerequisite | Test | Rollback |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `readprompted.beehiiv.com` home and signup | `NEW/` and `NEW/subscribe/` | Owner, in beehiiv settings | Platform live | Sign up with a test address; it appears in the dashboard with its source | Leave beehiiv signup on; it is never switched off, only de-linked |
| 2 | beehiiv post permalinks `readprompted.beehiiv.com/p/<slug>` (in 11 sent emails, LinkedIn posts, shares) | Cannot be redirected: beehiiv owns that domain. Keep the beehiiv archive online. `NEW/p/<slug>/` already forwards to the new issue page for anyone who swaps the domain | None | None | Open three old links after cutover | Not applicable |
| 3 | GitHub Pages root `andrew-pellegrino.github.io/prompted/` redirects to beehiiv with `utm_source=prompted_home` | Redirect to `NEW/?utm_source=prompted_home&utm_medium=web&utm_campaign=prompted_home` | Claude, one-line change to `index.html` on `main` | Owner approval to touch `main` | Load the address; land on the new home with UTMs intact | Revert the commit |
| 4 | Index subscribe buttons (`subscribeUrl` in `index/data.json`, and the header link in `index/index.html`) point to beehiiv with `utm_source=index` | `NEW/s/index/` | Claude, coordinated with the Monday Index task | Owner approval; do it right after a Monday Index run | Click both buttons; signup is recorded as `index / web / prompted_index` | Revert the commit |
| 5 | Public Index at `andrew-pellegrino.github.io/prompted/index/` | Stays where it is. `NEW/index/` is a copy rebuilt from the same file. Anchors are identical | None | None | Open a term anchor on both | Not applicable |
| 6 | "Forwarded this by a friend? Subscribe here" link in each email (beehiiv, `utm_source=forward`) | `NEW/s/forward/` in the new template. Old emails keep the beehiiv link, which still works | Built into the template | None | Click from a test email | Not applicable |
| 7 | Scheduled task "Prompted LinkedIn Post" (Mondays about 8:57 a.m. ET, schedules a Typefully post for 11:30 a.m. with `utm_source=linkedin&utm_medium=social&utm_campaign=prompted_written_YYYY_MM_DD`, logs to the LinkedIn Log) | Same task, link target becomes `NEW/issues/<slug>/` with the same three UTM values. The site records them at signup | Owner edits the task prompt | New issue page exists before 8:57 a.m. | Dry-run the task text against a published issue | Restore the old prompt text |
| 8 | Typefully posts already scheduled or published | Leave as they are; they point at beehiiv, which stays online | None | None | None | Not applicable |
| 9 | Scheduled task "Prompted Index Weekly Update" (Mondays about 1:59 p.m. ET, edits only `index/data.json` on `main`) | No change. After cutover, `platform-dev` work must merge without touching `index/` | None | None | Run happens as usual | Not applicable |
| 10 | Scheduled task "Prompted Weekly Setup" (Sundays about noon ET) | No change | None | None | None | Not applicable |
| 11 | Sunday production and beehiiv publishing (currently WorkGPT, with a Claude shadow test planned for November 15) | Publishing step becomes: add the approved issue file to `platform/content/issues/`, build, QA, test send, owner approval in the dashboard, schedule | Owner decides who runs it | Sending identity live; shadow test passed | Run one full shadow week alongside beehiiv without sending to subscribers | Publish that week through beehiiv as today |
| 12 | Monday 8:45 a.m. ET send from beehiiv | Send from the platform. beehiiv's scheduled send must be off for that week so nobody gets two emails | Owner, same morning | All acceptance tests pass | Dashboard shows sent counts; owner's own inboxes receive one copy | If the platform send has not started by 9:00 a.m., send from beehiiv instead; never both |
| 13 | Google Drive records that name beehiiv as the website (Current State doc, Growth Roadmap, CRM, website checklist) | Update the addresses after cutover | Owner or Claude with Drive access | Cutover done | Read-through | Not applicable |
| 14 | LinkedIn profile link, any printed QR codes or flyers | Point to `NEW/s/linkedin/` and organisation short links | Owner | Platform live | Scan and click | Old links still reach beehiiv |
| 15 | beehiiv subscriber list | Becomes a frozen backup. Do not delete the publication | Owner | Full export stored privately | Counts match the dashboard on cutover day | Re-enable beehiiv sending |

Not inspected this session (read them before cutover): the live Typefully queue, the exact text of each
scheduled task, the LinkedIn profile, and the Drive "LinkedIn Log".

## Order of operations on cutover week

1. Sunday: full beehiiv export to private storage; import into the platform; reconcile counts by status.
2. Sunday: build the new issue, run QA, send tests to the owner's inboxes, owner approves and schedules.
3. Sunday night: confirm beehiiv has no send scheduled for Monday.
4. Monday 8:45 a.m.: platform sends. Watch the dashboard.
5. Monday: change rows 3, 4 and 7. Rows 13 and 14 during the week.
6. Keep beehiiv untouched for at least four weeks as the rollback path.

## Rollback

The platform never deletes anything in beehiiv. To go back: export new signups from the dashboard as CSV,
import them into beehiiv, schedule the next issue in beehiiv, and revert rows 3, 4 and 7. People who
unsubscribed on the platform must be unsubscribed in beehiiv before any beehiiv send (export the
suppression list from the dashboard).
