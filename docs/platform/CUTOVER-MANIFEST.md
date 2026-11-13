# Cutover manifest

Nothing in this file has been changed in production. Every row is a planned change that needs the owner's
approval. Until cutover, beehiiv keeps sending and every existing link keeps working.

`NEW` below is **https://readprompted.org**, the owner's domain. The platform already answers there in
preview mode (hidden from search engines, dry-run sending). Cutover means switching it to production mode
and pointing everything in this table at it, not moving the site again.

## Go / no-go: current answer is NO-GO

| Acceptance test | State |
| --- | --- |
| Site, archive, Index copy and signup work in a deployed preview | **Passed** on the preview, November 11 (synthetic data). |
| Private database deployed with dashboard login | **Passed**: anonymous, forged and cross-site requests are refused. |
| Real subscriber ledger imported and reconciled against beehiiv counts | **Passed in private staging** (November 12): 262 = 255 active + 2 pending + 5 unsubscribed, comparison in agreement, CRM organisations merged. Must be refreshed the day before cutover. |
| A sending identity exists and passes SPF/DKIM/DMARC checks | **Passed with a real receiver** (November 13): Cloudflare's mail servers judged our SES test email SPF pass, DKIM pass (signed as readprompted.org), DMARC pass, with List-Unsubscribe and one-click headers. |
| Amazon SES production access granted, with a daily limit above the whole list and a per-second rate known | **Waiting**: request under review since November 12 (sandbox: 200 a day, 1 a second). |
| Bounce, complaint and delivery reports arrive and are processed (signed SNS) | Built and tested with simulated reports; **the SNS subscription is the owner's next step** (`OWNER-SETUP.md` 6f). |
| Amazon Auto Validation off, or explicitly accepted by the owner | **Passed**: off, confirmed through the SES API, November 12. |
| Whole list deliverable inside the Monday window, with room to grow | Bulk sending verified against real SES (simulator and the owner's inbox). Paced rehearsals: 255 in about 4 to 5 minutes on the free plan. Real production rate known only after approval. |
| Test issues reach the inbox (not Spam) for Miami University and personal Gmail (Outlook and iCloud optional) | **In progress**: authorised SES tests sent to the owner's Miami inbox on November 13 (tracking off and on); the owner reports where they landed. Personal Gmail needs production access (the sandbox only reaches verified recipients). |
| **Cross-group inbox placement**: owner-approved seed tests and staged sends reach the inbox for each audience group: Miami University addresses in several groups (the October SEPi cohort, Founders, AWE, faculty and staff, the November batch), other university addresses, and non-university addresses (personal Gmail required; Outlook and iCloud optional). Each group judged on evidence beyond "delivered" (a recipient confirms where it landed, or Miami IT message trace) | **Not started.** Open concern: two October SEPi members say they never saw Prompted although beehiiv records all four issues as delivered. See `DELIVERABILITY.md`. Changing provider alone is not assumed to fix this. |
| New sending address announced to readers from beehiiv in two issues | Not started. |
| Warm-up completed with staged sends while beehiiv covers the rest | Not started. |
| Side-by-side beehiiv versus Prompted comparison | Separate final due-diligence test, arranged with the owner later. |
| Postal address set in the footer | **Passed**: owner-approved address stored as a Worker secret (not in the repository). |
| One full dry run of a Monday send against the real ledger | **Passed** (November 12): locally against simulated SES (21 of 21 checks: pace, dedupe, failures, recovery, unsubscribes, warm-up, staged send) and on the deployed staging database with the dry-run adapter paced like SES. |
| Rollback rehearsed | Procedure written (`CUTOVER-RUNBOOK.md`); switch-off path tested (audience lock, cancel, stale-claim handling). A production-mode deploy was deliberately not performed. |

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

The exact steps, switches and rollback are in `CUTOVER-RUNBOOK.md`. Live go/no-go: `GET /api/admin/cutover/readiness`.


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
