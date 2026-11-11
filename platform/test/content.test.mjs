import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { build, loadIssues, loadSite } from '../src/build.mjs';
import { parseWeekLabel, slugForWeek, mastheadWeek, scheduledSendFor, nextSendSlot, nyWallTimeToUtc } from '../src/lib/weeks.mjs';
import { blocksText, validateIssue, CLOSING_LINE } from '../src/lib/issue-model.mjs';
import { renderIssueEmail, fillRecipient, EMAIL_WIDTH } from '../src/lib/render-email.mjs';
import { renderIssueWeb } from '../src/lib/render-web.mjs';
import { runQA } from '../src/lib/qa.mjs';
import { termsInIssue, indexAnchors } from '../src/lib/index-terms.mjs';
import { parseCsv, parseCsvObjects, toCsv } from '../src/lib/csv.mjs';
import { createHash } from 'node:crypto';
import { ROOT } from './helpers.mjs';

const site = { ...(await loadSite({ SITE_URL: 'https://preview.example' })), postal_address: '123 Test Street, Oxford, OH 45056' };
const issues = await loadIssues();
const strip = (h) => h.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const squash = (s) => s.replace(/\s+/g, '');

test('week labels parse to correct dates and slugs', () => {
  const w = parseWeekLabel('April 27–May 3, 2026');
  assert.deepEqual([w.start, w.end, w.nominal_send_date], ['2026-04-27', '2026-05-03', '2026-05-04']);
  assert.equal(slugForWeek(w), 'week-of-april-27-may-3-2026');
  assert.equal(mastheadWeek(w), 'Week of April 27–May 3');
  assert.equal(parseWeekLabel('November 1-8, 2026').label, 'November 1–8, 2026');
  assert.equal(parseWeekLabel('December 27, 2026–January 3, 2027').start, '2026-12-27');
  assert.throws(() => parseWeekLabel('Sometime in May'));
});

test('Monday 8:45 a.m. Eastern is DST-correct', () => {
  assert.equal(nyWallTimeToUtc('2026-10-26', 8, 45).toISOString(), '2026-10-26T12:45:00.000Z'); // EDT
  assert.equal(nyWallTimeToUtc('2026-11-02', 8, 45).toISOString(), '2026-11-02T13:45:00.000Z'); // EST, day after the change
  assert.equal(nyWallTimeToUtc('2027-03-15', 8, 45).toISOString(), '2027-03-15T12:45:00.000Z'); // EDT again
  assert.equal(nextSendSlot(new Date('2026-11-10T23:00:00Z')).utc, '2026-11-16T13:45:00.000Z');
  assert.equal(nextSendSlot(new Date('2026-11-16T13:45:00Z')).utc, '2026-11-23T13:45:00.000Z'); // strictly after
});

test('all 31 migrated issues are valid, ordered, unique and unchanged since extraction', () => {
  assert.equal(issues.length, 31);
  assert.equal(new Set(issues.map((i) => i.slug)).size, 31);
  assert.equal(new Set(issues.map((i) => i.source.post_id)).size, 31);
  for (const [n, i] of issues.entries()) {
    validateIssue(i);
    assert.equal(i.number, n + 1);
    if (n) assert.ok(i.week.end > issues[n - 1].week.end, `${i.slug} is out of order`);
    assert.equal(createHash('sha256').update(blocksText(i.blocks)).digest('hex'), i.source.content_sha256, `${i.slug} text differs from the extracted original`);
    assert.equal(i.blocks[0].role, 'opening');
  }
  assert.equal(issues[0].week.label, 'April 6–12, 2026');
  assert.equal(issues[30].week.label, 'November 1–8, 2026');
});

test('scheduled send for a migrated beehiiv-era issue matches the real send time', () => {
  for (const i of issues.filter((x) => x.publication.basis === 'beehiiv_email_send')) assert.equal(scheduledSendFor(i.week).utc.slice(0, 16), i.publication.sent_at.slice(0, 16), i.slug);
  assert.equal(issues.filter((x) => x.publication.basis === 'beehiiv_email_send').length, 11);
});

test('web and email renderings carry exactly the approved words', () => {
  for (const i of [issues[0], issues[5], issues[15], issues[18], issues[30]]) {
    const src = squash(blocksText(i.blocks));
    assert.equal(squash(strip(renderIssueWeb(i).html)), src, `web drift in ${i.slug}`);
    const email = renderIssueEmail(i, site);
    assert.ok(squash(strip(email.html)).includes(src), `email drift in ${i.slug}`);
    assert.ok(squash(email.text).includes(squash(blocksText(i.blocks.filter((b) => b.type === 'paragraph')).slice(0, 400))));
  }
});

test('email template: live masthead text, 608px, unsubscribe, no per-week image', () => {
  const i = issues[30], email = renderIssueEmail(i, site);
  assert.match(email.html, new RegExp(`max-width:${EMAIL_WIDTH}px`));
  assert.ok(email.html.includes('Week of November 1–8') && email.html.includes('Your Weekly AI Brief') && email.html.includes('Prepared for the John W. Altman Institute for Entrepreneurship'));
  const imgs = [...email.html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(imgs, ['https://preview.example/img/miami-altman-lockup.png'], 'only the stable institutional lockup is an image');
  assert.equal(email.subject, 'Prompted — Week of November 1–8, 2026');
  const filled = fillRecipient(email.html, { unsubscribeUrl: 'https://x.test/u/abc', webUrl: 'https://x.test/i?a=1&b=2', openPixelUrl: null, token: 'abc' });
  assert.ok(!filled.includes('{{') && filled.includes('https://x.test/u/abc') && filled.includes('a=1&amp;b=2'));
  assert.ok(fillRecipient(email.text, { unsubscribeUrl: 'u', webUrl: 'https://x.test/i?a=1&b=2', openPixelUrl: null }, false).includes('a=1&b=2'));
  assert.ok(new TextEncoder().encode(email.html).length < 102 * 1024, 'under the Gmail clipping limit');
});

test('QA passes a current-format issue and catches real problems', () => {
  const good = runQA(issues[30], site, { strict: true });
  assert.equal(good.ok, true, JSON.stringify(good.findings.filter((f) => f.level === 'error')));
  const broken = structuredClone(issues[30]);
  broken.blocks.find((b) => b.role === 'closing').children[0].text = 'That’s the week, see you next Monday.';
  broken.blocks.splice(1, 0, { type: 'paragraph', children: [{ text: 'A second opening paragraph with a ' }, { text: 'bad link', href: 'http://example.com/x' }] });
  const codes = runQA(broken, site, { strict: true }).findings.map((f) => f.code);
  for (const c of ['closing', 'opening-split', 'link-scheme']) assert.ok(codes.includes(c), `expected ${c}`);
  assert.ok(runQA(issues[30], { ...site, postal_address: 'TODO' }, {}).findings.some((f) => f.code === 'email-address'));
  // Early issues predate the fixed closing line; lenient mode reports that as a warning, not an error.
  assert.equal(runQA(issues[0], site, { strict: false }).ok, true);
  const anchors = new Set(['real-term']);
  const linked = structuredClone(issues[30]);
  linked.blocks[0].children.push({ text: 'x', href: 'https://preview.example/index/#missing-term' });
  assert.ok(runQA(linked, site, { indexAnchors: anchors }).findings.some((f) => f.code === 'index-anchor'));
});

test('Index integration is read-only and links only to live Index anchors', async () => {
  const src = path.join(ROOT, '..', 'index', 'data.json');
  const before = await readFile(src, 'utf8');
  await build({ SITE_URL: 'https://preview.example', SITE_ENV: 'preview' });
  assert.equal(await readFile(src, 'utf8'), before, 'the canonical Index data must not be modified by the build');
  const data = JSON.parse(before), copy = JSON.parse(await readFile(path.join(ROOT, 'dist', 'index', 'data.json'), 'utf8'));
  assert.equal(copy.terms.length, data.terms.length);
  assert.equal(copy.issuesTracked, data.issuesTracked);
  assert.deepEqual(copy.pendingReview, data.pendingReview);
  assert.equal(copy.subscribeUrl, '/s/index/');
  const anchors = indexAnchors(data), terms = termsInIssue(issues[30], data);
  assert.ok(terms.length > 0);
  for (const t of terms) assert.ok(anchors.has(t.anchor));
  const pending = new Set(data.pendingReview.map((p) => p.term));
  for (const t of terms) assert.ok(!pending.has(t.term) || data.terms.some((x) => x.term === t.term), 'pending terms are never promoted');
});

test('build output: pages, redirects, preview is not indexable, no private data', async () => {
  const d = (p) => readFile(path.join(ROOT, 'dist', p), 'utf8');
  const home = await d('index.html');
  assert.ok(home.includes('noindex') && home.includes('Development preview'));
  assert.ok((await d('robots.txt')).includes('Disallow: /'));
  assert.ok((await d('issues/week-of-november-1-8-2026/index.html')).includes('AI ran into limits this week'));
  assert.ok((await d('p/prompted-9d9f892956451611/index.html')).includes('/issues/week-of-october-25-november-1-2026/'));
  assert.ok((await d('s/founders/index.html')).includes('utm_source=founders&amp;utm_medium=partner&amp;utm_campaign=founders_2026'));
  assert.equal(Object.keys(JSON.parse(await d('data/search.json'))).length, 31);
  const prod = await build({ SITE_URL: 'https://prompted.example', SITE_ENV: 'production' });
  assert.equal(prod.site.env, 'production');
  assert.ok(!(await d('index.html')).includes('noindex'));
  await build({ SITE_URL: 'https://preview.example', SITE_ENV: 'preview' });
});

test('CSV round-trips quotes, commas, newlines and neutralises formulas', () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, y","he said ""hi"""\n"multi\nline",z\n'), [['a', 'b'], ['x, y', 'he said "hi"'], ['multi\nline', 'z']]);
  const { records } = parseCsvObjects('﻿Email,First Name\n a@b.co ,Ann\n');
  assert.deepEqual(records, [{ _row: 2, Email: 'a@b.co', 'First Name': 'Ann' }]);
  assert.throws(() => parseCsvObjects('a,a\n1,2'));
  assert.throws(() => parseCsv('"unterminated'));
  const csv = toCsv(['email', 'note'], [{ email: 'a@b.co', note: '=HYPERLINK("x")' }, { email: 'c@d.co', note: 'plain, text' }]);
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`) && csv.includes('"plain, text"'));
});

test('closing line constant matches the production specification', () => assert.equal(CLOSING_LINE, 'That’s the week. See you next Monday.'));

test('approved text imports without changing a word, and round-trips an existing issue', async () => {
  const { importIssueText, parseInline } = await import('../src/lib/import-text.mjs');
  assert.deepEqual(parseInline('Plain **bold,** then *italic* and [a link](https://example.com/a?b=1), 2 * 3 = 6, \\*literal\\*.'),
    [{ text: 'Plain ' }, { text: 'bold,', bold: true }, { text: ' then ' }, { text: 'italic', italic: true }, { text: ' and ' }, { text: 'a link', href: 'https://example.com/a?b=1' }, { text: ', 2 * 3 = 6, *literal*.' }]);
  // Serialise issue 31 to the text form and import it back: identical words, structure and marks.
  const src = issues[30];
  const esc = (t) => t.replace(/([\\*\[\]])/g, '\\$1');
  const inline = (runs) => runs.map((r) => { let t = esc(r.text); if (r.italic) t = `*${t}*`; if (r.bold) { const m = /^(.*?)(\s*)$/.exec(t); t = `**${m[1]}**${m[2]}`; } return t; }).join('');
  const md = [`# Week of ${src.week.label}`, `> ${src.subtitle}`, '', ...src.blocks.map((b) => (b.type === 'heading' ? '#'.repeat(b.level) + ' ' + inline(b.children) : b.role === 'signoff' ? '— Prompted' : inline(b.children)) + '\n')].join('\n');
  const back = importIssueText(md, { number: 31 });
  assert.equal(blocksText(back.blocks), blocksText(src.blocks));
  assert.deepEqual([back.slug, back.week, back.subtitle], [src.slug, src.week, src.subtitle]);
  assert.deepEqual(back.blocks.map((b) => [b.type, b.level, b.role]), src.blocks.map((b) => [b.type, b.level, b.role]));
  assert.equal(runQA(back, site, { strict: true }).ok, true);
  assert.throws(() => importIssueText('No title line\n\nBody'), /first line/);
  assert.throws(() => importIssueText('# Week of Sometime\n\nBody'));
});
