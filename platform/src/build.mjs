#!/usr/bin/env node
// Static site build: content/issues/*.json + ../index -> dist/
//   SITE_URL=https://example.workers.dev SITE_ENV=preview|production node src/build.mjs
import { readFile, writeFile, mkdir, readdir, rm, cp } from 'node:fs/promises';
import { readIndexData } from './lib/index-source.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { esc, renderRuns } from './lib/html.mjs';
import { validateIssue, runsText, readMinutes, blocksText, sections } from './lib/issue-model.mjs';
import { renderIssueWeb, renderMasthead } from './lib/render-web.mjs';
import { renderIssueEmail, fillRecipient } from './lib/render-email.mjs';
import { termsInIssue } from './lib/index-terms.mjs';
import { scheduledSendFor } from './lib/weeks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(ROOT, '..');
const DIST = path.join(ROOT, 'dist');

async function wranglerVars() {
  try {
    const text = await readFile(path.join(ROOT, 'wrangler.toml'), 'utf8');
    const out = {};
    for (const m of text.matchAll(/^(SITE_PUBLIC|SIGNUP_URL)\s*=\s*"([^"]*)"/gm)) out[m[1]] = m[2];
    return out;
  } catch { return {}; }
}

/** External signup link with campaign tags carried over (used while another service still holds the list). */
function externalSignup(site, utm = {}) {
  const u = new URL(site.signup_url);
  for (const [k, v] of Object.entries(utm)) if (v) u.searchParams.set(k, v);
  return u.toString();
}

export async function loadSite(env = process.env) {
  const site = JSON.parse(await readFile(path.join(ROOT, 'content', 'site.json'), 'utf8'));
  site.url = (env.SITE_URL || 'http://localhost:8787').replace(/\/$/, '');
  site.env = env.SITE_ENV || 'preview';
  // Before cutover the public website can be live (indexed, no preview banner) while signups still go to the
  // current sender. Defaults come from wrangler.toml so the Worker and the built pages always agree.
  const vars = env === process.env ? await wranglerVars() : {}; // explicit env objects (tests) stay self-contained
  const pick = (k) => (env[k] !== undefined ? env[k] : vars[k]) || '';
  site.public = site.env === 'production' || pick('SITE_PUBLIC') === 'true';
  site.signup_url = site.env === 'production' ? '' : pick('SIGNUP_URL').replace(/\/$/, '');
  site.asset_base_url = site.url;
  site.index_url = site.url + '/index/';
  site.forward_subscribe_url = site.url + '/s/forward/';
  if (env.POSTAL_ADDRESS) site.postal_address = env.POSTAL_ADDRESS;
  return site;
}

export async function loadIssues() {
  const dir = path.join(ROOT, 'content', 'issues');
  const issues = [];
  for (const f of (await readdir(dir)).filter((x) => x.endsWith('.json')).sort()) issues.push(validateIssue(JSON.parse(await readFile(path.join(dir, f), 'utf8'))));
  issues.sort((a, b) => a.number - b.number);
  const slugs = new Set(issues.map((i) => i.slug));
  if (slugs.size !== issues.length) throw new Error('Duplicate issue slugs');
  issues.forEach((x, i) => { if (x.number !== i + 1) throw new Error(`Issue numbering gap at ${x.slug}`); });
  return issues;
}

const storyTitles = (issue) => issue.blocks.filter((b) => b.type === 'heading' && b.level === 3).map((b) => runsText(b.children).trim());
const issueUrl = (i) => `/issues/${i.slug}/`;

function signupForm(id, label = 'Subscribe free', site = null) {
  if (site?.signup_url) return `<p class="signup"><a class="btn" href="${esc(externalSignup(site, { utm_source: 'readprompted_org', utm_medium: 'web', utm_campaign: id }))}">${label}</a></p>`;
  return `<form class="signup" data-signup="${id}" action="/api/subscribe" method="post">
  <label class="vh" for="email-${id}">Email address</label>
  <input id="email-${id}" name="email" type="email" required autocomplete="email" placeholder="you@example.com">
  <div class="hp" aria-hidden="true"><label>Leave this field empty <input name="website" tabindex="-1" autocomplete="off"></label></div>
  <button class="btn" type="submit">${label}</button>
  <p class="signup-msg" role="status" aria-live="polite"></p>
</form>`;
}

const subscribeHref = (site, campaign) => (site.signup_url ? externalSignup(site, { utm_source: 'readprompted_org', utm_medium: 'web', utm_campaign: campaign }) : '/subscribe/');
const longDate = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const shortMonth = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const pad2 = (n) => String(n).padStart(2, '0');
const storyAnchors = (issue) => renderIssueWeb(issue).toc.filter((t) => t.level === 3);
const ARROW = '<svg class="arr" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 8h11M9 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
const SEARCH_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15.5 15.5 21 21" stroke="currentColor" stroke-width="2"/></svg>';

function layout(site, { title, description, pathName, body, current = '', ogType = 'website', extraHead = '', jsonLd = null, latest = null }) {
  const canonical = site.url + pathName;
  const noindex = !site.public;
  const navLink = (href, key, label) => `<a href="${href}"${current === key ? ' aria-current="page"' : ''}>${label}</a>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${noindex ? '<meta name="robots" content="noindex, nofollow">' : ''}
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0f0f0e" media="(prefers-color-scheme: dark)">
<link rel="canonical" href="${esc(canonical)}">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="alternate" type="application/rss+xml" title="${esc(site.name)}" href="/feed.xml">
<meta property="og:site_name" content="${esc(site.name)}">
<meta property="og:type" content="${ogType}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${esc(site.url)}/img/og.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;1,6..72,400&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/styles.css">
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>` : ''}
${extraHead}
</head>
<body class="${current ? 'pg-' + current : ''}">
<a class="skip" href="#main">Skip to content</a>
${noindex ? '<div class="preview-banner">Development preview. Not the live Prompted site.</div>' : ''}
<header class="plate"><div class="wrap">
  <div class="plate-mid">
    <a class="nameplate" href="/" aria-label="${esc(site.name)} home">${esc(site.name)}</a>
    <nav class="plate-nav" aria-label="Main">
      ${navLink('/issues/', 'issues', 'Archive')}
      ${navLink('/index/', 'index', 'Index')}
      <a class="sub-btn" href="${esc(subscribeHref(site, 'header'))}">Subscribe free</a>
    </nav>
  </div>
  <div class="plate-rule"></div>
  <div class="dateline"><span>${esc(site.tagline)}</span><span class="dl-for">${esc(site.attribution)}</span>${latest ? `<span class="num">No. ${latest.number} · ${esc(longDate(latest.publication.date))}</span>` : `<span>Every Monday, 8:45 a.m. Eastern</span>`}</div>
</div></header>
<main id="main">
${body}
</main>
<footer class="site"><div class="wrap">
  <div class="foot-top">
    <div class="foot-brand">
      <a class="foot-name" href="/">${esc(site.name)}</a>
      <p>${esc(site.description)}</p>
      <a class="sub-btn" href="${esc(subscribeHref(site, 'footer'))}">Subscribe free</a>
    </div>
    <nav class="foot-nav" aria-label="Footer">
      <h4>Read</h4><a href="/">This week</a><a href="/issues/">Archive</a><a href="/index/">Prompted Index</a><a href="/feed.xml">RSS</a>
    </nav>
    <nav class="foot-nav" aria-label="About">
      <h4>About</h4><a href="${esc(subscribeHref(site, 'footer-links'))}">Subscribe</a><a href="/privacy/">Privacy</a>
    </nav>
    <div class="foot-lockup"><img src="/img/miami-altman-lockup.png" width="120" height="95" alt="Miami University, John W. Altman Institute for Entrepreneurship"><p>${esc(site.attribution)}.</p></div>
  </div>
  <p class="foot-fine">© ${new Date().getUTCFullYear()} ${esc(site.name)}. Written by ${esc(site.author)}. Free, every Monday at 8:45 a.m. Eastern.</p>
</div></footer>
<script src="/assets/site.js" defer></script>
</body>
</html>`;
}

const issueLi = (i) => `<li data-issue="${i.slug}" data-hay="${esc((i.week.label + ' ' + i.subtitle + ' ' + storyTitles(i).join(' ') + ' issue ' + i.number).toLowerCase())}"><a href="${issueUrl(i)}">
  <span class="no num">${pad2(i.number)}</span>
  <span class="body"><span class="wk">Week of ${esc(i.week.label)}</span><span class="st">${esc(i.subtitle)}</span><span class="stories">${storyTitles(i).slice(0, 2).map(esc).join('<i>·</i>')}</span></span>
  ${ARROW}
</a></li>`;

function leaderboard(indexData, issuesTracked, n = 6) {
  if (!indexData?.terms?.length) return '';
  const top = [...indexData.terms].sort((a, b) => b.issues - a.issues || b.mentions - a.mentions || a.term.localeCompare(b.term)).slice(0, n);
  const total = indexData.issuesTracked || issuesTracked;
  return `<ol class="board">${top.map((t, i) => `<li><a href="/index/#${encodeURIComponent(t.anchor)}"><span class="rk">${i + 1}</span><span class="bt"><span class="bn">${esc(t.term)}</span><span class="bs num">${t.issues}/${total}</span><span class="bar"><i style="width:${Math.round((t.issues / total) * 100)}%"></i></span></span></a></li>`).join('')}</ol>`;
}

function homePage(site, issues, indexData) {
  const latest = issues.at(-1), earlier = issues.slice(-6, -1).reverse();
  const opening = latest.blocks.find((b) => b.role === 'opening');
  const stories = storyAnchors(latest);
  const terms = indexData ? termsInIssue(latest, indexData, 10) : [];
  const termCount = indexData?.terms?.length || 0;
  const body = `<section class="front wrap">
  <div class="lead">
    <p class="kicker">This week · Issue No. ${latest.number}</p>
    <h1 class="lead-h"><a href="${issueUrl(latest)}">${esc(latest.subtitle)}</a></h1>
    <p class="byline">Week of ${esc(latest.week.label)} <i>·</i> ${readMinutes(latest)} min read <i>·</i> By ${esc(site.author)}</p>
    ${opening ? `<div class="deck clamp"><p>${renderRuns(opening.children)}</p></div>` : ''}
    <a class="read-on" href="${issueUrl(latest)}">Read the full issue ${ARROW}</a>
    <div class="contents">
      <h2 class="sec-h">In this issue</h2>
      <ol>${stories.map((s, i) => `<li><a href="${issueUrl(latest)}#${s.id}"><span class="rk">${i + 1}</span><span>${esc(s.text)}</span></a></li>`).join('')}</ol>
    </div>
    <div class="figures">
      <div class="fig"><b class="num">${issues.length}</b><span>issues</span></div>
      <div class="fig"><b class="num">${termCount || '—'}</b><span>terms explained</span></div>
      <div class="fig"><b class="num">8:45</b><span>Mondays, ET</span></div>
    </div>
  </div>
  <div class="vr" aria-hidden="true"></div>
  <aside class="rail">
    <div class="subbox">
      <p class="kicker">Free every Monday</p>
      <h2>Start the week knowing what changed in AI.</h2>
      <p>The biggest developments, what they add up to, and what they mean for you, in one email at 8:45 a.m. Eastern.</p>
      ${signupForm('home-hero', 'Subscribe free', site)}
      <p class="fine">One email a week. No ads. Unsubscribe in one click.</p>
    </div>
    <h2 class="sec-h">Earlier issues</h2>
    <ol class="past">${earlier.map((i) => `<li><a href="${issueUrl(i)}"><span class="no num">${pad2(i.number)}</span><span class="body"><span class="wk">${esc(i.week.label)}</span><span class="st">${esc(i.subtitle)}</span></span></a></li>`).join('')}</ol>
    <a class="all" href="/issues/">All ${issues.length} issues ${ARROW}</a>
  </aside>
</section>

${indexData ? `<section class="band"><div class="wrap">
  <div class="band-head"><h2>From the Prompted Index</h2><p>The AI terms Prompted keeps using, explained in plain English and counted across every issue.</p><a class="btn-line" href="/index/">Open the Index ${ARROW}</a></div>
  <div class="band-grid">
    <div><h3 class="sec-h">What keeps coming up</h3>${leaderboard(indexData, issues.length)}<p class="note">Share of the ${indexData.issuesTracked || issues.length} issues that used each term.</p></div>
    <div class="vr" aria-hidden="true"></div>
    <div><h3 class="sec-h">Terms in this week's issue</h3><div class="tiles">${terms.map((t) => `<a href="/index/#${encodeURIComponent(t.anchor)}">${esc(t.term)}</a>`).join('')}</div>
      <form class="search" action="/index/" role="search">${SEARCH_ICON}<label class="vh" for="iq">Search the Index</label><input id="iq" name="q" type="search" placeholder="Look up an AI term" autocomplete="off"></form></div>
  </div>
</div></section>` : ''}

<section class="inside wrap">
  <h2 class="sec-big">Inside every issue</h2>
  <div class="cols">
    <div><span class="n num">01</span><h3>The Biggest Developments</h3><p>The handful of stories that changed something, with the facts, the caveats and why each one matters.</p></div>
    <div><span class="n num">02</span><h3>Worth Knowing Briefly</h3><p>The smaller stories you would want to have heard about, in a paragraph each.</p></div>
    <div><span class="n num">03</span><h3>Patterns Worth Watching</h3><p>What the week's news adds up to, so you see the direction and not only the headlines.</p></div>
    <div><span class="n num">04</span><h3>Why This Week Matters</h3><p>Plain takeaways for students, founders, faculty, staff and administrators.</p></div>
  </div>
</section>

<section class="closer"><div class="wrap">
  <p class="closer-q">${esc(site.promise)}</p>
  <div class="closer-act">${signupForm('home-footer', 'Subscribe free', site)}<p class="fine">Prepared for the John W. Altman Institute for Entrepreneurship at Miami University.</p></div>
</div></section>`;
  return layout(site, { title: `${site.name} — ${site.tagline}`, description: site.description, pathName: '/', body, current: 'home', latest,
    jsonLd: { '@context': 'https://schema.org', '@type': 'WebSite', name: site.name, url: site.url + '/', description: site.description } });
}

function archivePage(site, issues) {
  const byMonth = new Map();
  for (const i of [...issues].reverse()) { const m = shortMonth(i.publication.date); if (!byMonth.has(m)) byMonth.set(m, []); byMonth.get(m).push(i); }
  const first = issues[0];
  const body = `<header class="page-head wrap">
  <p class="kicker">The archive</p>
  <h1>Every issue of ${esc(site.name)}.</h1>
  <p class="dek">${issues.length} weekly issues since ${esc(shortMonth(first.publication.date))}, newest first. Search covers every word of every issue.</p>
  <div class="search">${SEARCH_ICON}<label class="vh" for="q">Search the archive</label><input id="q" type="search" placeholder="Search ${issues.length} issues" data-search="/data/search.json" autocomplete="off"><span class="kbd">/</span></div>
  <p class="count" data-count aria-live="polite">${issues.length} issues</p>
</header>
<div class="wrap arch">
  ${[...byMonth].map(([m, list]) => `<h2 class="month" data-year><span>${esc(m)}</span></h2><ol class="arch-list">${list.map(issueLi).join('')}</ol>`).join('\n')}
</div>`;
  return layout(site, { title: `Archive — ${site.name}`, description: `All ${issues.length} issues of ${site.name}, searchable.`, pathName: '/issues/', body, current: 'issues', latest: issues.at(-1) });
}

function issuePage(site, issue, issues, indexData) {
  const { html, toc } = renderIssueWeb(issue);
  const prev = issues[issue.number - 2], next = issues[issue.number];
  const terms = indexData ? termsInIssue(issue, indexData) : [];
  const url = site.url + issueUrl(issue);
  const share = encodeURIComponent(url);
  const tocList = `<ol>${toc.map((t) => `<li class="l${t.level}"><a href="#${t.id}">${esc(t.text)}</a></li>`).join('')}</ol>`;
  // Soft gate: split after N blocks. Everything stays in the HTML (and readable without JavaScript).
  const parts = html.split('\n');
  const gated = site.gate === 'soft' && parts.length > site.gate_after_blocks + 4;
  const head = gated ? parts.slice(0, site.gate_after_blocks).join('\n') : html;
  const rest = gated ? parts.slice(site.gate_after_blocks).join('\n') : '';
  const body = `<div class="progress" aria-hidden="true"><i></i></div>
<header class="art-head wrap">
  <p class="kicker"><a href="/issues/">Issue No. ${issue.number}</a> · Week of ${esc(issue.week.label)}</p>
  <h1 class="art-h">${esc(issue.subtitle)}</h1>
  <div class="art-meta">
    <span>By ${esc(site.author)}</span><span>${esc(longDate(issue.publication.date))}</span><span>${readMinutes(issue)} min read</span>
  </div>
</header>
<div class="wrap">
<details class="toc"><summary>In this issue</summary>${tocList}</details>
<div class="issue-layout">
<nav class="toc-side" aria-label="In this issue"><p>In this issue</p>${tocList}</nav>
<article class="issue">
${head}
${gated ? `<div class="gate" data-gate hidden><p class="kicker">Free every Monday</p><h2>Keep reading. It is free.</h2><p>Get ${esc(site.name)} in your inbox every Monday morning.</p>${signupForm('issue-gate', 'Subscribe free', site)}<button class="skip-gate" type="button">I already subscribe. Continue reading.</button></div>
<div data-gated>
${rest}
</div>` : ''}
</article>
</div>
<div class="after">
  ${terms.length ? `<section class="terms" aria-labelledby="terms-h"><h2 id="terms-h" class="sec-h">Terms from this issue in the Prompted Index</h2><div class="tiles">${terms.map((t) => `<a href="/index/#${encodeURIComponent(t.anchor)}">${esc(t.term)}</a>`).join('')}</div></section>` : ''}
  <div class="share"><span>Share this issue</span><a href="https://www.linkedin.com/sharing/share-offsite/?url=${share}" rel="noopener">LinkedIn</a><a href="mailto:?subject=${encodeURIComponent(issue.title)}&body=${share}">Email</a><a href="${esc(url)}">Permalink</a></div>
  <div class="subbox wide"><div><p class="kicker">Free every Monday</p><h2>Get the next issue in your inbox.</h2><p>${esc(site.promise)}</p></div><div>${signupForm('issue-end', 'Subscribe free', site)}<p class="fine">One email a week. No ads. Unsubscribe in one click.</p></div></div>
  <nav class="pager" aria-label="Issues">${prev ? `<a href="${issueUrl(prev)}"><small>← Previous issue</small><b>Week of ${esc(prev.week.label)}</b><span>${esc(prev.subtitle)}</span></a>` : '<span></span>'}${next ? `<a class="next" href="${issueUrl(next)}"><small>Next issue →</small><b>Week of ${esc(next.week.label)}</b><span>${esc(next.subtitle)}</span></a>` : '<span></span>'}</nav>
</div>
</div>`;
  return layout(site, { title: issue.title, description: issue.subtitle, pathName: issueUrl(issue), body, current: 'issue', ogType: 'article', latest: issues.at(-1),
    jsonLd: { '@context': 'https://schema.org', '@type': 'NewsArticle', headline: issue.title, description: issue.subtitle, datePublished: issue.publication.date, author: { '@type': 'Person', name: site.author }, publisher: { '@type': 'Organization', name: site.name }, mainEntityOfPage: url, isAccessibleForFree: true } });
}

function subscribePage(site, issues) {
  const latest = issues.at(-1);
  const body = `<header class="page-head wrap center">
  <p class="kicker">Free every Monday</p>
  <h1>Subscribe to ${esc(site.name)}.</h1>
  <p class="dek">${esc(site.promise)}</p>
  ${signupForm('subscribe-page', 'Subscribe free', site)}
  <p class="fine">One email, ${esc(site.send_slot_label)}. Unsubscribe any time with one click.</p>
</header>
<section class="inside wrap">
  <div class="cols three">
    <div><span class="n num">01</span><h3>What arrives</h3><p>One issue a week: the biggest developments, what they add up to, and what they mean for you.</p></div>
    <div><span class="n num">02</span><h3>What does not</h3><p>No ads, no sponsored links, no daily mail. Your address is never shared.</p></div>
    <div><span class="n num">03</span><h3>Try it first</h3><p><a href="${issueUrl(latest)}">Read this week's issue</a> or browse <a href="/issues/">all ${issues.length}</a>.</p></div>
  </div>
</section>`;
  return layout(site, { title: `Subscribe — ${site.name}`, description: site.description, pathName: '/subscribe/', body, current: 'subscribe', latest });
}

const simplePage = (site, pathName, title, inner) => layout(site, { title: `${title} — ${site.name}`, description: site.description, pathName, body: `<header class="page-head wrap"><h1>${esc(title)}</h1></header><div class="wrap"><div class="prose">${inner}</div></div>` });

const redirectPage = (to) => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Prompted</title><meta name="robots" content="noindex"><link rel="canonical" href="${esc(to)}"><meta http-equiv="refresh" content="0; url=${esc(to)}"><script>location.replace(${JSON.stringify(to)}+location.hash)</script></head><body><p><a href="${esc(to)}">Continue</a></p></body></html>`;

async function out(rel, content) {
  const file = path.join(DIST, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

export async function build(env = process.env) {
  const site = await loadSite(env);
  const issues = await loadIssues();
  const { data: indexData, source: indexSource } = await readIndexData(REPO, env);
  if (!indexData) console.warn('Index data not found; issue pages will not show Index terms.');
  else if (env.INDEX_SOURCE) console.log(`Index data: ${indexSource}`);

  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
  await cp(path.join(ROOT, 'static'), DIST, { recursive: true });
  await out('assets/styles.css', await readFile(path.join(ROOT, 'src', 'site', 'styles.css')));
  await out('assets/site.js', await readFile(path.join(ROOT, 'src', 'site', 'site.js')));
  await cp(path.join(ROOT, 'admin'), path.join(DIST, 'admin'), { recursive: true });

  await out('index.html', homePage(site, issues, indexData));
  await out('issues/index.html', archivePage(site, issues));
  await out('subscribe/index.html', subscribePage(site, issues));
  await out('subscribe/confirmed/index.html', simplePage(site, '/subscribe/confirmed/', 'You are subscribed', `<p>Thanks for confirming. ${esc(site.name)} arrives ${esc(site.send_slot_label)}.</p><p><a href="/issues/">Read the archive</a> while you wait.</p>`));
  await out('unsubscribed/index.html', simplePage(site, '/unsubscribed/', 'You are unsubscribed', `<p>You will not receive further issues of ${esc(site.name)}. If this was a mistake, you can <a href="/subscribe/">subscribe again</a>.</p>`));
  await out('privacy/index.html', simplePage(site, '/privacy/', 'Privacy', `<p>${esc(site.name)} stores the email address you give us, when and where you signed up (including campaign tags in the link you followed), and whether each issue was delivered to you.</p><h2>Opens and clicks</h2><p>Issues may contain a small image and links that pass through ${esc(site.name)}'s own website on the way to their destination, so we can see roughly how many readers open an issue and which links they find useful. These addresses contain a random code that is different for every issue; they do not contain your email address. We record the time, which link was followed, and a general kind of device (for example "browser" or "security scanner"). We do not store your IP address or detailed browser information, and we use no outside tracking or advertising service.</p><p>Detailed open and click records are deleted after 90 days; only totals per issue are kept after that. Figures are approximate because mail apps and security scanners can open emails and links automatically, and some readers block images. Reports show totals and groups of at least five readers. Only the editor can see, inside the private subscriber record, whether a particular issue was delivered, opened or clicked for you; that is used to sort out delivery problems.</p><h2>Your choices</h2><p>We use this information only to send the newsletter and understand what readers find useful. We do not sell or share your address. Every email has a one-click unsubscribe link, which works whether or not anything else does. You can ask for your data to be deleted by replying to any issue.</p>`));
  await out('404.html', simplePage(site, '/404.html', 'Page not found', '<p>That page does not exist. Try the <a href="/issues/">archive</a> or the <a href="/">home page</a>.</p>'));

  const search = {};
  for (const issue of issues) {
    await out(`issues/${issue.slug}/index.html`, issuePage(site, issue, issues, indexData));
    await out(`data/issues/${issue.slug}.json`, JSON.stringify(issue));
    if (issue.source.slug) await out(`p/${issue.source.slug}/index.html`, redirectPage(issueUrl(issue))); // old beehiiv permalink paths
    const email = renderIssueEmail(issue, site);
    await out(`email/${issue.slug}.html`, fillRecipient(email.html, { unsubscribeUrl: site.url + '/unsubscribed/', webUrl: site.url + issueUrl(issue), openPixelUrl: null }).replace('<head>', '<head><meta name="robots" content="noindex">'));
    search[issue.slug] = blocksText(issue.blocks).toLowerCase();
  }
  await out('data/search.json', JSON.stringify(search));
  await out('data/issues.json', JSON.stringify(issues.map((i) => ({ number: i.number, slug: i.slug, title: i.title, subtitle: i.subtitle, week: i.week, publication: i.publication, source: { system: i.source.system, post_id: i.source.post_id, slug: i.source.slug }, sections: sections(i).slice(1).map((s) => s.title), send: scheduledSendFor(i.week) }))));
  await out('data/site.json', JSON.stringify({ name: site.name, tagline: site.tagline, attribution: site.attribution, url: site.url, env: site.env, campaigns: site.campaigns, send_slot_label: site.send_slot_label }));

  for (const c of site.campaigns) await out(`s/${c.code}/index.html`, redirectPage(site.signup_url ? externalSignup(site, { utm_source: c.utm_source, utm_medium: c.utm_medium, utm_campaign: c.utm_campaign }) : `/subscribe/?utm_source=${encodeURIComponent(c.utm_source)}&utm_medium=${encodeURIComponent(c.utm_medium)}&utm_campaign=${encodeURIComponent(c.utm_campaign)}`));

  // Prompted Index: copied byte-for-byte, except the subscribe target, which points at this site.
  if (indexData) {
    await cp(path.join(REPO, 'index'), path.join(DIST, 'index'), { recursive: true });
    const sub = '/s/index/';
    await out('index/data.json', JSON.stringify({ ...indexData, subscribeUrl: sub }));
    const page = await readFile(path.join(REPO, 'index', 'index.html'), 'utf8');
    // The live Index's subscribe button overflows narrow phones (same on GitHub Pages); fix it in this copy only.
    const phoneFix = '<style>@media (max-width:480px){.plate-mid{flex-wrap:wrap;row-gap:8px}a.sub-btn{white-space:normal;max-width:100%;box-sizing:border-box;text-align:center}}</style></head>';
    await out('index/index.html', page.replace('</head>', phoneFix).replace(/(<a class="sub-btn" href=")[^"]*(")/, `$1${sub}$2`).replace('<a class="nameplate"', '<a href="/" style="position:absolute;left:16px;top:10px;font:13px Arial,sans-serif;text-decoration:none;z-index:3">← Prompted</a><a class="nameplate"'));
  }

  const rssItems = [...issues].reverse().slice(0, 20).map((i) => `<item><title>${esc(i.title)}</title><link>${site.url}${issueUrl(i)}</link><guid isPermaLink="true">${site.url}${issueUrl(i)}</guid><pubDate>${new Date(i.publication.sent_at || i.publication.date + 'T12:45:00Z').toUTCString()}</pubDate><description>${esc(i.subtitle)}</description></item>`).join('\n');
  await out('feed.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>${esc(site.name)}</title><link>${site.url}/</link><description>${esc(site.description)}</description><language>en-us</language>\n${rssItems}\n</channel></rss>\n`);
  const urls = ['/', '/issues/', '/subscribe/', '/index/', ...issues.map(issueUrl)];
  await out('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `<url><loc>${site.url}${u}</loc></url>`).join('\n')}\n</urlset>\n`);
  await out('robots.txt', site.public ? `User-agent: *\nAllow: /\nDisallow: /admin/\nDisallow: /email/\nSitemap: ${site.url}/sitemap.xml\n` : 'User-agent: *\nDisallow: /\n');
  return { site, issues: issues.length, indexTerms: indexData?.terms?.length ?? 0 };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  build().then((r) => console.log(`Built ${r.issues} issues (${r.site.env}, ${r.site.url}); Index terms available: ${r.indexTerms}`)).catch((e) => { console.error(e); process.exit(1); });
}
