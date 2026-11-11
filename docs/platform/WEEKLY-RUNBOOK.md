# Weekly runbook (for after cutover; rehearse it in shadow weeks first)

How one approved issue becomes a web page and an email on the platform. Until cutover is approved,
steps 6 to 8 are done in dry-run mode only, and beehiiv sends the real issue as usual.

## Sunday

1. **Approved text in.** Save the approved issue as a text file in the small format described at the top
   of `platform/src/lib/import-text.mjs` (a `# Week of ...` line, `##` section headings, `###` story
   headings, `**bold**`, `[link text](https://...)`). Wording is copied exactly; nothing is rewritten.

```bash
npm run new-issue -- path/to/approved.md
```

   This prints the QA result without writing anything. Add `--write` when it is clean.

   No command line: in the dashboard open **Publish, Check a new issue before publishing**, paste the
   text, read the checks and the email preview, and download the issue file. That file is what gets
   added to `platform/content/issues/`.

2. **Build and check.**

```bash
npm test
```

```bash
npm run qa
```

   QA blocks on: a split opening, missing or reordered sections, a wrong closing line, bad links, an Index
   link to a term that is not live, any difference between the approved words and the rendered web page or
   email, a missing unsubscribe link, a missing or placeholder postal address.

3. **Publish the page.** Commit the new file in `platform/content/issues/` on the working branch and deploy
   (commands in `CLAUDE.md`). The issue page, the archive, search, RSS and the home page update together.

4. **Preview** in the dashboard: **Publish**, choose the issue. The email preview is the exact HTML that
   will be sent.

5. **Test email** to the authorised test inboxes (**Send test**). Record where it landed under
   **Tools, Where test emails landed**. While inbox placement is still being established, every real test
   needs the owner's go-ahead first.

6. **Owner approval.** **Prepare send**, read the checks, then **I approve this issue for sending**.
   Approval is tied to the exact text: if the issue file changes afterwards, the send refuses to go and
   must be prepared again.

7. **Schedule.** Leave the time empty for Monday 8:45 a.m. Eastern (daylight saving is handled). For a
   staged send, enter a tag so only that group is included first.

## Monday

8. **Send.** At the scheduled minute the platform snapshots the active, unsuppressed subscribers and sends
   in small batches within each provider's daily limit and any warm-up cap. If a limit is reached it
   continues the next day. If the provider says stop, or a sign-in has expired, it pauses, loses nobody,
   and shows the reason in the dashboard. Nobody can receive the same issue twice.

9. **Verify** in the dashboard: sent, failed and skipped counts; then, for a staged send,
   **Send to the N subscribers not yet included**.

10. **After.** Bounces and complaints reported by the provider suppress the address automatically.
    For a sender with no reports (Gmail), mark bounced addresses by hand: open the person, set status
    **bounced**.

## If something goes wrong

- The send has not started by 9:00 a.m.: send from the fallback (beehiiv, until it is retired). Never both.
- Failures listed as "unconfirmed": check the provider's own log before using **Retry failed**, because
  those messages may already have been delivered.
- Wrong text went out: nothing can recall email. Correct the issue file, redeploy the page, and decide
  whether a short correction is warranted.

## Monthly

- Download a full backup (**Tools**) and store it in private storage.
- Compare a fresh export from any other system still in use with the database (**Import, Compare only**).
