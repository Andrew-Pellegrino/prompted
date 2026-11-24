#!/usr/bin/env node
// Static site build: content/issues/*.json + ../index -> dist/
//   SITE_URL=https://example.workers.dev SITE_ENV=preview|production node src/build.mjs
import { readFile, writeFile, mkdir, readdir, rm, cp } from 'node:fs/promises';
import { readIndexData } from './lib/index-source.mjs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { esc, renderRuns, localIndexHref } from './lib/html.mjs';
import { validateIssue, runsText, readMinutes, wordCount, blocksText, sections } from './lib/issue-model.mjs';
import { renderIssueWeb, renderMasthead } from './lib/render-web.mjs';
import { renderIssueEmail, fillRecipient } from './lib/render-email.mjs';
import { termsInIssue } from './lib/index-terms.mjs';
import { risingTerms, termTimeline } from './lib/trends.mjs';
import { scheduledSendFor, mastheadWeek } from './lib/weeks.mjs';

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
const storyAnchors = (issue) => {
  const h3 = renderIssueWeb(issue).toc.filter((t) => t.level === 3);
  if (h3.length) return h3;
  // Early issues used bold lead-ins instead of story headings: list those from The Biggest Developments.
  const out = []; let inBig = false;
  for (const b of issue.blocks) {
    if (b.type === 'heading' && b.level === 2) { inBig = /biggest developments/i.test(runsText(b.children)); continue; }
    if (inBig && b.type === 'paragraph' && b.children?.[0]?.bold) out.push({ id: '', text: b.children[0].text.trim().split(/(?<=[.:”])\s+(?=[A-Z])/)[0].replace(/[:.]\s*$/, '') });
  }
  return out;
};
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
<link rel="stylesheet" href="/assets/styles.css?v=${site.asset_v?.css || ''}">
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
  ${current === 'home' && latest ? `<div class="mast-line"><p class="mast-tag2">${esc(site.tagline)}</p><p class="mast-when"><span class="dot"></span>Every Monday · 8:45 a.m. ET</p><nav class="mnav" aria-label="Sections">${navLink('/issues/', 'issues', 'Archive')}${navLink('/index/', 'index', 'Index')}</nav></div>
  <div class="plate-rule mast-rule"></div>` : `<div class="dateline"><nav class="mnav" aria-label="Sections">${navLink('/issues/', 'issues', 'Archive')}${navLink('/index/', 'index', 'Index')}</nav><span class="dl-tag">${esc(site.tagline)}</span><span class="dl-for">${esc(site.attribution)}</span><span>Every Monday, 8:45 a.m. ET</span></div>
  <div class="plate-rule"></div>`}
</div></header>
<main id="main">
${body}
</main>
<footer class="site"><div class="wrap foot">
  <a class="foot-lockup" href="/"><picture><source srcset="/img/lockup-dark.png" media="(prefers-color-scheme: dark)"><img src="/img/lockup-light.png" width="80" height="63" alt="Miami University, John W. Altman Institute for Entrepreneurship"></picture></a>
  <div class="foot-main">
    <nav aria-label="Footer"><a href="/">This week</a><a href="/issues/">Archive</a><a href="/index/">Index</a><a href="${esc(subscribeHref(site, 'footer'))}">Subscribe</a><a href="/feed.xml">RSS</a><a href="/privacy/">Privacy</a></nav>
    <p>© ${new Date().getUTCFullYear()} ${esc(site.name)}. Written by ${esc(site.author)}. ${esc(site.attribution)}.</p>
  </div>
</div></footer>
<script src="/assets/site.js?v=${site.asset_v?.js || ''}" defer></script>
</body>
</html>`;
}

const issueLi = (i) => `<li data-issue="${i.slug}" data-hay="${esc((i.week.label + ' ' + i.subtitle + ' ' + storyTitles(i).join(' ') + ' issue ' + i.number).toLowerCase())}"><a href="${issueUrl(i)}">
  <span class="no num">${pad2(i.number)}</span>
  <span class="body"><span class="wk">Week of ${esc(i.week.label)}</span><span class="st"><span class="u">${esc(i.subtitle)}</span></span><span class="stories">${storyTitles(i).slice(0, 2).map(esc).join('<i>·</i>')}</span></span>
  ${ARROW}
</a></li>`;

function leaderboard(indexData, issuesTracked, n = 6) {
  if (!indexData?.terms?.length) return '';
  const top = [...indexData.terms].sort((a, b) => b.issues - a.issues || b.mentions - a.mentions || a.term.localeCompare(b.term)).slice(0, n);
  const total = indexData.issuesTracked || issuesTracked;
  return `<ol class="board">${top.map((t, i) => `<li><a href="/index/#${encodeURIComponent(t.anchor)}"><span class="rk">${i + 1}</span><span class="bt"><span class="bn">${esc(t.term)}</span><span class="bs num">${t.issues}/${total}</span><span class="bar"><i style="width:${Math.round((t.issues / total) * 100)}%"></i></span></span></a></li>`).join('')}</ol>`;
}

function homePage(site, issues, indexData) {
  const latest = issues.at(-1), earlier = issues.slice(-8, -1).reverse();
  const front = site.front || {};
  const opening = latest.blocks.find((b) => b.role === 'opening');
  const stories = storyAnchors(latest);
  const byNo = new Map(issues.map((i) => [i.number, i]));
  const N = issues.length, SHOW = 4;
  const story = (s, i) => `<li${i >= SHOW ? ' class="extra"' : ''} style="--d:${i}"><a href="${issueUrl(latest)}${s.id ? '#' + s.id : ''}"><span class="rk">${i + 1}</span><span><span class="u">${esc(s.text)}</span></span></a></li>`;
  const mon = (i) => shortMonth(i.publication.date).slice(0, 3);
  const span = (a, b) => (mon(a) === mon(b) ? mon(a) : `${mon(a)}–${mon(b)}`);
  const timeline = (t) => {
    const sq = t.seen.map((x, i) => x ? `<a class="on" style="--i:${i}" href="${issueUrl(issues[i])}" aria-label="Issue ${issues[i].number}, week of ${esc(issues[i].week.label)}" data-tip="No. ${issues[i].number} · ${esc(issues[i].week.label.replace(/, \d{4}$/, ''))}"></a>` : `<i style="--i:${i}"></i>`).join('');
    const ticks = issues.map((i, n) => (n === 0 || mon(i) !== mon(issues[n - 1])) ? `<span style="grid-column:${n + 1}">${esc(mon(i))}</span>` : '').join('');
    return `<div class="tl2">
      <a class="tl2-term" href="/index/#${encodeURIComponent(t.anchor)}">${esc(t.term)}</a>
      <div class="tl2-strip" style="--n:${N}">${sq}</div><div class="tl2-ticks" style="--n:${N}">${ticks}</div>
    </div>`;
  };
  // archive card: AI capability (stylized exponential) over time, one dot per issue, "you are here" at the latest
  const X0 = 34, X1 = 286, Y0 = 118, YT = 14, cap = (t) => (Math.exp(3.2 * t) - 1) / (Math.exp(3.2) - 1);
  const pt = (t) => [X0 + t * (X1 - X0), Y0 - 8 - cap(t) * (Y0 - YT - 8)];
  const path = Array.from({ length: 61 }, (_, j) => { const [x, y] = pt(j / 60); return `${j ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`; }).join(' ');
  const [lx, ly] = pt(1);
  const dots = issues.map((_, n) => { const [x, y] = pt(n / (N - 1)); return `<circle class="dt${n === N - 1 ? ' now' : ''}" style="--i:${n}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${n === N - 1 ? 4.2 : 2.1}"/>`; }).join('');
  const mticks = []; issues.forEach((i, n) => { if (n === 0 || mon(i) !== mon(issues[n - 1])) { const [x] = pt(n / (N - 1)); mticks.push(`<text class="mt" x="${x.toFixed(1)}" y="${Y0 + 14}">${esc(mon(i))}</text>`); } });
  const chart = `<svg class="cap-chart" viewBox="0 0 300 140" role="img" aria-label="AI capability rising faster over time, with one dot for each of the ${N} issues and the latest marked: you are here">
    <defs><linearGradient id="capfill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="g0"/><stop offset="1" class="g1"/></linearGradient></defs>
    <path class="ax" d="M${X0} ${YT - 4} V${Y0} H${X1 + 6}"/>
    <text class="al" x="${X0 - 6}" y="${YT + 2}" transform="rotate(-90 ${X0 - 6} ${YT + 2})" text-anchor="end">AI capability</text>
    <path class="area" d="${path} L${X1} ${Y0} L${X0} ${Y0} Z"/>
    <line class="here" x1="${X0}" x2="${X1}" y1="${ly.toFixed(1)}" y2="${ly.toFixed(1)}"/>
    <text class="here-t" x="${X0 + 6}" y="${(ly - 5).toFixed(1)}">You are here. It has never moved faster.</text>
    <path class="curve" d="${path}" pathLength="1"/>${dots}${mticks.join('')}
  </svg>`;
  const dests = new Map((indexData?.destinations || []).map((d) => [d.id, d]));
  const total = indexData?.issuesTracked || N;
  const pool = (indexData?.terms || []).filter((t) => t.issues >= Math.round(total * 0.12) && t.issues <= Math.round(total * 0.5) && dests.get(t.dest)?.def && t.term.length > 3)
    .map((t) => ({ t: t.term, a: t.anchor, d: dests.get(t.dest).def }));
  const termHtml = (x) => `<a class="it" href="/index/#${encodeURIComponent(x.a)}"><b>${esc(x.t)}</b><span>${esc(x.d)}</span></a>`;
  const body = `<div class="fp wrap">
<section class="fp-sec fp-top" aria-labelledby="s-big">
  <h2 id="s-big" class="fp-label">This Week in AI</h2>
  <div class="fp-top-grid">
    <div class="fp-lead">
      <h3 class="lead-h"><a href="${issueUrl(latest)}"><span class="ul">${esc(latest.subtitle)}</span></a></h3>
      <p class="chips in-anim"><span>No. ${latest.number}</span><span>${esc(latest.week.label.replace(/, \d{4}$/, ''))}</span><span>${readMinutes(latest)} min read</span></p>
      ${opening ? `<div class="deck clamp in-anim"><p>${renderRuns(opening.children, { link: (href) => ({ href: localIndexHref(href, '/index/') }) })}</p></div>` : ''}
      <a class="sub-btn read-btn in-anim" href="${issueUrl(latest)}">Read this week's issue ${ARROW}</a>
    </div>
    ${stories.length ? `<div class="fp-side">
      <h3 class="fp-sub-h">The Biggest Developments</h3>
      <ol class="fp-stories" data-more>${stories.map(story).join('')}</ol>
      ${stories.length > SHOW ? `<button class="more-btn" type="button" data-more-btn aria-expanded="false"><span class="closed">Show all ${stories.length} stories</span><span class="open">Show fewer</span></button>` : ''}
    </div>` : ''}
  </div>
</section>

<section class="fp-sec" aria-labelledby="s-brief">
  <h2 id="s-brief" class="fp-h sd">Worth Knowing Briefly</h2>
  <div class="split">
    <div class="split-main">
      <ol class="brief-list">${earlier.map((i) => `<li class="sd"><a href="${issueUrl(i)}"><span class="no num">${i.number}</span><span class="body"><span class="wk">${esc(i.week.label.replace(/, \d{4}$/, ''))}</span><span class="st"><span class="u">${esc(i.subtitle)}</span></span></span></a></li>`).join('')}</ol>
    </div>
    <div class="split-side">
      <a class="card-link arch-card sd" href="/issues/">
        <span class="kicker">The Archive</span>
        <b><span class="u">${N} Issues and Counting</span></b>
        ${chart}
        <span class="go">Browse and search every issue ${ARROW}</span>
      </a>
      ${indexData ? `<div class="card-link idx-card sd">
        <span class="kicker">The Prompted Index</span>
        <b>${indexData.terms.length} AI Terms, Without the Jargon</b>
        <span class="idx-terms" data-terms>${pool.slice(0, 3).map(termHtml).join('')}</span>
        <a class="go" href="/index/">Open the Index ${ARROW}</a>
        <script type="application/json" id="term-pool">${JSON.stringify(pool).replace(/</g, '\\u003c')}</script>
      </div>` : ''}
    </div>
  </div>
</section>

<section class="fp-sec" aria-labelledby="s-pat">
  <h2 id="s-pat" class="fp-h sd">Patterns Worth Watching</h2>
  <p class="legend sd">Each square is one issue, oldest first. Filled means that issue covered it; tap one to read it.</p>
  ${(front.patterns || []).map((p) => `<div class="pattern-block sd">
    <p class="pattern"><b>${esc(p.lead)}</b> ${esc(p.body)}${p.issues?.length ? ` <span class="see">See ${p.issues.map((n) => byNo.get(n)).filter(Boolean).map((i) => `<a href="${issueUrl(i)}">${esc(i.week.label.replace(/, \d{4}$/, ''))}</a>`).join(', ')}.</span>` : ''}</p>
    ${indexData ? (p.terms || []).slice(0, 1).map((t) => termTimeline(issues, indexData, t)).filter(Boolean).map(timeline).join('') : ''}
  </div>`).join('\n  ')}
</section>

<section class="fp-sec" aria-labelledby="s-why">
  <h2 id="s-why" class="fp-h sd">Why Prompted Matters to You</h2>
  <div class="lenses">${(front.lenses || []).map((l) => `<p class="lens sd"><strong>${esc(l.label)}</strong> ${esc(l.text)}</p>`).join('')}</div>
</section>

<section class="finale sd" aria-labelledby="s-end">
  <div class="fin-act">
    <h2 id="s-end" class="fin-h">Get the Next One in Your Inbox</h2>
    <p class="fin-next" data-next-issue>The next issue arrives Monday at 8:45 a.m. Eastern.</p>
    ${signupForm('home-hero', 'Subscribe free', site)}
    <p class="fin-facts">Free, one email a week, no ads, and one click to unsubscribe.</p>
  </div>
  <div class="fin-close"><p>That’s the week. See you next Monday.</p><p class="fp-signoff">— Prompted</p></div>
</section>
</div>`;
  return layout(site, { title: `${site.name} — ${site.tagline}`, description: site.description, pathName: '/', body, current: 'home', latest,
    jsonLd: { '@context': 'https://schema.org', '@type': 'WebSite', name: site.name, url: site.url + '/', description: site.description } });
}

function archivePage(site, issues) {
  const sendDate = (i) => i.week.nominal_send_date || i.publication.date;
  const byMonth = new Map();
  for (const i of [...issues].reverse()) { const m = shortMonth(i.publication.date); if (!byMonth.has(m)) byMonth.set(m, []); byMonth.get(m).push(i); }
  const byMon = new Map();
  for (const i of issues) { const m = shortMonth(i.publication.date); if (!byMon.has(m)) byMon.set(m, []); byMon.get(m).push(i); }
  const cal = [...byMon].map(([m, list]) => `<div class="cal-m"><h3>${esc(m.replace(/ \d{4}$/, ''))}</h3><div class="dots">${list.map((i) => `<button class="cd iss" type="button" data-n="${i.number}" aria-label="Issue ${i.number}, week of ${esc(i.week.label)}: ${esc(i.subtitle)}"><span class="in num">${i.number}</span></button>`).join('')}</div></div>`);
  const data = Object.fromEntries(issues.map((i) => [i.number, { url: issueUrl(i), week: i.week.label, date: longDate(sendDate(i)), title: i.subtitle, stories: storyAnchors(i).map((t) => [t.id, t.text]), slug: i.slug, hay: (i.week.label + ' ' + i.subtitle + ' ' + storyTitles(i).join(' ')).toLowerCase() }]));
  const body = `<header class="page-head wrap arch-head">
  <h1>Every Issue of ${esc(site.name)}</h1>
  <p class="dek">${issues.length} weekly issues since ${esc(shortMonth(issues[0].publication.date))}. Pick an issue to unfold it, or search every word of every issue.</p>
  <div class="search">${SEARCH_ICON}<label class="vh" for="q">Search the archive</label><input id="q" type="search" placeholder="Search ${issues.length} issues" data-search="/data/search.json" autocomplete="off"></div>
  <p class="count" data-count aria-live="polite">${issues.length} issues</p>
</header>
<section class="wrap cal" data-cal aria-label="Issues by date">
  <div class="cal-grid">${cal.join('')}</div>
  <div class="cal-panel" hidden></div>
  <script type="application/json" id="cal-data">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>
</section>
<div class="wrap arch">
  <h2 class="sec-big">Every Issue, Newest First</h2>
  ${[...byMonth].map(([m, list]) => `<h2 class="month" data-year><span>${esc(m)}</span></h2><ol class="arch-list">${list.map(issueLi).join('')}</ol>`).join('\n')}
</div>`;
  return layout(site, { title: `Archive — ${site.name}`, description: `All ${issues.length} issues of ${site.name}, searchable.`, pathName: '/issues/', body, current: 'issues' });
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
<header class="nl-head wrap">
  <picture><source srcset="/img/lockup-dark.png" media="(prefers-color-scheme: dark)"><img class="nl-logo" src="/img/lockup-light.png" width="120" height="95" alt="Miami University, John W. Altman Institute for Entrepreneurship"></picture>
  <p class="nl-name">${esc(site.name)}</p>
  <p class="nl-tag">${esc(site.tagline)}</p>
  <p class="nl-week">${esc(mastheadWeek(issue.week))}</p>
  <p class="nl-for">${esc(site.attribution)}</p>
  <h1 class="vh">${esc(issue.title)}</h1>
  <div class="nl-meta"><a href="/issues/">Issue No. ${issue.number}</a><span>By ${esc(site.author)}</span><span>${esc(longDate(issue.publication.date))}</span><span>${readMinutes(issue)} min read</span></div>
</header>
<div class="wrap">
<details class="toc"><summary>In This Issue</summary>${tocList}</details>
<div class="issue-layout">
<nav class="toc-side" aria-label="In this issue"><p>In This Issue</p>${tocList}</nav>
<article class="issue">
${head}
${gated ? `<div class="gate" data-gate hidden><p class="kicker">Free Every Monday</p><h2>Keep Reading. It’s Free.</h2><p>Get ${esc(site.name)} in your inbox every Monday morning.</p>${signupForm('issue-gate', 'Subscribe free', site)}<button class="skip-gate" type="button">I already subscribe. Continue reading.</button></div>
<div data-gated>
${rest}
</div>` : ''}
</article>
</div>
<div class="after">
  ${terms.length ? `<section class="terms" aria-labelledby="terms-h"><h2 id="terms-h" class="sec-h">Terms From This Issue in the Prompted Index</h2><div class="tiles">${terms.map((t) => `<a href="/index/#${encodeURIComponent(t.anchor)}">${esc(t.term)}</a>`).join('')}</div></section>` : ''}
  <div class="share"><span>Share this issue</span><a href="https://www.linkedin.com/sharing/share-offsite/?url=${share}" rel="noopener">LinkedIn</a><a href="mailto:?subject=${encodeURIComponent(issue.title)}&body=${share}">Email</a><a href="${esc(url)}">Permalink</a></div>
  <div class="subbox wide"><div><p class="kicker">Free Every Monday</p><h2>Get the Next Issue in Your Inbox</h2><p>${esc(site.promise)}</p></div><div>${signupForm('issue-end', 'Subscribe free', site)}<p class="fine">One email a week. No ads. Unsubscribe in one click.</p></div></div>
  <nav class="pager" aria-label="Issues">${prev ? `<a href="${issueUrl(prev)}"><small>← Previous issue</small><b><span class="u">Week of ${esc(prev.week.label)}</span></b><span>${esc(prev.subtitle)}</span></a>` : '<span></span>'}${next ? `<a class="next" href="${issueUrl(next)}"><small>Next issue →</small><b><span class="u">Week of ${esc(next.week.label)}</span></b><span>${esc(next.subtitle)}</span></a>` : '<span></span>'}</nav>
</div>
</div>`;
  return layout(site, { title: issue.title, description: issue.subtitle, pathName: issueUrl(issue), body, current: 'issue', ogType: 'article',
    jsonLd: { '@context': 'https://schema.org', '@type': 'NewsArticle', headline: issue.title, description: issue.subtitle, datePublished: issue.publication.date, author: { '@type': 'Person', name: site.author }, publisher: { '@type': 'Organization', name: site.name }, mainEntityOfPage: url, isAccessibleForFree: true } });
}

function subscribePage(site, issues) {
  const latest = issues.at(-1), stories = storyAnchors(latest);
  const lenses = (site.front?.lenses || []);
  const body = `<section class="sub-hero wrap">
  <div class="sub-copy">
    <p class="kicker">Free Every Monday</p>
    <h1>Start the week knowing what changed in AI.</h1>
    <p class="dek">${esc(site.promise)}</p>
    ${signupForm('subscribe-page', 'Subscribe free', site)}
    <p class="fin-facts">Free, one email a week at 8:45 a.m. Eastern, no ads, and one click to unsubscribe.</p>
  </div>
  <a class="sub-sample" href="${issueUrl(latest)}">
    <span class="kicker">This Week’s Issue · No. ${latest.number}</span>
    <b><span class="u">${esc(latest.subtitle)}</span></b>
    <ol>${stories.slice(0, 5).map((t, i) => `<li><span class="rk">${i + 1}</span>${esc(t.text)}</li>`).join('')}</ol>
    <span class="go">Read it before you subscribe ${ARROW}</span>
  </a>
</section>
<section class="wrap fp-sec">
  <h2 class="fp-h">Why Readers Subscribe</h2>
  <div class="lenses">${lenses.map((l) => `<p class="lens"><strong>${esc(l.label)}</strong> ${esc(l.text)}</p>`).join('')}</div>
</section>`;
  return layout(site, { title: `Subscribe — ${site.name}`, description: site.description, pathName: '/subscribe/', body, current: 'subscribe' });
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
  // Versioned asset addresses: a changed stylesheet or script gets a new URL, so browsers never pair new pages with old styles.
  const hash10 = async (f) => createHash('sha256').update(await readFile(path.join(ROOT, 'src', 'site', f))).digest('hex').slice(0, 10);
  site.asset_v = { css: await hash10('styles.css'), js: await hash10('site.js') };
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
  await out('subscribe/confirmed/index.html', simplePage(site, '/subscribe/confirmed/', 'You Are Subscribed', `<p>Thanks for confirming. ${esc(site.name)} arrives ${esc(site.send_slot_label)}.</p><p><a href="/issues/">Read the archive</a> while you wait.</p>`));
  await out('unsubscribed/index.html', simplePage(site, '/unsubscribed/', 'You Are Unsubscribed', `<p>You will not receive further issues of ${esc(site.name)}. If this was a mistake, you can <a href="/subscribe/">subscribe again</a>.</p>`));
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
    const phoneFix = '<style>@media (max-width:480px){.plate-mid{flex-wrap:wrap;row-gap:8px}a.sub-btn{white-space:normal;max-width:100%;box-sizing:border-box;text-align:center}}.site-bar{border-bottom:1px solid var(--hair);font-family:Arial,"Helvetica Neue",Helvetica,sans-serif}.site-bar div{max-width:var(--w);margin:0 auto;padding:10px 28px;display:flex;gap:22px;align-items:center;font-size:14px;font-weight:700}.site-bar a{text-decoration:none;color:var(--ink)}.site-bar a:hover{color:var(--red)}.site-bar .sb-name{margin-right:auto;font-size:18px;letter-spacing:-.03em}.site-bar a[aria-current]{box-shadow:0 2px 0 var(--red)}@media (max-width:680px){.site-bar div{padding:10px 18px}}</style></head>';
    await out('index/index.html', page.replace('</head>', phoneFix).replace(/(<a class="sub-btn" href=")[^"]*(")/, `$1${sub}$2`).replace(/<body([^>]*)>/, `<body$1><nav class="site-bar" aria-label="Prompted"><div><a class="sb-name" href="/">Prompted</a><a href="/issues/">Archive</a><a href="/index/" aria-current="page">Index</a></div></nav>`));
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
