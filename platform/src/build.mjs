#!/usr/bin/env node
// Static site build: content/issues/*.json + ../index -> dist/
//   SITE_URL=https://example.workers.dev SITE_ENV=preview|production node src/build.mjs
import { readFile, writeFile, mkdir, readdir, rm, cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { esc } from './lib/html.mjs';
import { validateIssue, runsText, readMinutes, blocksText, sections } from './lib/issue-model.mjs';
import { renderIssueWeb, renderMasthead } from './lib/render-web.mjs';
import { renderIssueEmail, fillRecipient } from './lib/render-email.mjs';
import { termsInIssue } from './lib/index-terms.mjs';
import { scheduledSendFor } from './lib/weeks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(ROOT, '..');
const DIST = path.join(ROOT, 'dist');

export async function loadSite(env = process.env) {
  const site = JSON.parse(await readFile(path.join(ROOT, 'content', 'site.json'), 'utf8'));
  site.url = (env.SITE_URL || 'http://localhost:8787').replace(/\/$/, '');
  site.env = env.SITE_ENV || 'preview';
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

function signupForm(id, label = 'Subscribe free') {
  return `<form class="signup" data-signup="${id}" action="/api/subscribe" method="post">
  <label class="vh" for="email-${id}">Email address</label>
  <input id="email-${id}" name="email" type="email" required autocomplete="email" placeholder="you@example.com">
  <div class="hp" aria-hidden="true"><label>Leave this field empty <input name="website" tabindex="-1" autocomplete="off"></label></div>
  <button class="btn" type="submit">${label}</button>
  <p class="signup-msg" role="status" aria-live="polite"></p>
</form>`;
}

function layout(site, { title, description, pathName, body, current = '', ogType = 'website', extraHead = '', jsonLd = null }) {
  const canonical = site.url + pathName;
  const noindex = site.env !== 'production';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${noindex ? '<meta name="robots" content="noindex, nofollow">' : ''}
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
<body>
<a class="skip" href="#main">Skip to content</a>
${noindex ? '<div class="preview-banner">Development preview. Not the live Prompted site.</div>' : ''}
<div class="nav"><div class="wrap">
  <a class="brand" href="/"><img src="/favicon.svg" alt="" width="26" height="26">${esc(site.name)}</a>
  <nav aria-label="Main">
    <a href="/issues/"${current === 'issues' ? ' aria-current="page"' : ''}>Archive</a>
    <a href="/index/">Index</a>
    <a class="btn" href="/subscribe/">Subscribe</a>
  </nav>
</div></div>
<main id="main">
${body}
</main>
<footer class="site"><div class="wrap">
  <p>© ${new Date().getUTCFullYear()} ${esc(site.name)}. ${esc(site.attribution)}.</p>
  <nav aria-label="Footer"><a href="/issues/">Archive</a><a href="/index/">Index</a><a href="/subscribe/">Subscribe</a><a href="/feed.xml">RSS</a><a href="/privacy/">Privacy</a></nav>
</div></footer>
<script src="/assets/site.js" defer></script>
</body>
</html>`;
}

const issueLi = (i) => `<li data-issue="${i.slug}" data-hay="${esc((i.week.label + ' ' + i.subtitle + ' ' + storyTitles(i).join(' ') + ' issue ' + i.number).toLowerCase())}"><a href="${issueUrl(i)}"><span class="no">${String(i.number).padStart(2, '0')}</span><span class="wk">Week of ${esc(i.week.label)}</span><span class="st">${esc(i.subtitle)}</span></a></li>`;

function homePage(site, issues) {
  const latest = issues.at(-1), recent = issues.slice(-5, -1).reverse();
  const body = `<section class="hero"><div class="wrap">
  <img class="lockup" src="/img/miami-altman-lockup.png" width="160" height="127" alt="Miami University, John W. Altman Institute for Entrepreneurship">
  <h1>${esc(site.name)}</h1>
  <p class="tag">${esc(site.tagline)}</p>
  <p class="for">${esc(site.attribution)}</p>
  <p class="promise">${esc(site.promise)}</p>
  ${signupForm('home-hero')}
  <p class="fine">Free. One email, ${esc(site.send_slot_label)}. Unsubscribe any time.</p>
</div></section>
<section class="block"><div class="wrap grid two">
  <div>
    <p class="kicker">Latest issue</p>
    <a class="lead-issue" href="${issueUrl(latest)}">
      <p class="wk">No. ${latest.number} · Week of ${esc(latest.week.label)} · ${readMinutes(latest)} min read</p>
      <h3>${esc(latest.subtitle)}</h3>
      <ul>${storyTitles(latest).slice(0, 5).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
      <span class="more">Read the issue →</span>
    </a>
    <div class="facts">
      <div><b>${issues.length}</b><span>issues in the archive</span></div>
      <div><b>${esc(site.send_slot_label.replace(/ at .*/, ''))}</b><span>8:45 a.m. Eastern, every week</span></div>
      <div><b>Free</b><span>no ads, one click to leave</span></div>
    </div>
  </div>
  <div>
    <p class="kicker">Recent issues</p>
    <ul class="issue-list">${recent.map(issueLi).join('')}</ul>
    <p style="margin:14px 0 0"><a href="/issues/">All ${issues.length} issues →</a></p>
  </div>
</div></section>
<section class="block"><div class="wrap">
  <p class="kicker">What you get</p>
  <h2 class="sec">The week in AI, sorted by what actually matters</h2>
  <div class="grid three who">
    <div><h3>The Biggest Developments</h3><p>The handful of stories that changed something, with the facts, the caveats and the reason each one matters.</p></div>
    <div><h3>Patterns Worth Watching</h3><p>What the week's news adds up to, so you can see the direction and not only the headlines.</p></div>
    <div><h3>Why This Week Matters</h3><p>Plain takeaways for students, founders and builders, faculty, staff and administrators.</p></div>
  </div>
</div></section>
<section class="block"><div class="wrap grid two">
  <div>
    <p class="kicker">Prompted Index</p>
    <h2 class="sec">Every AI term, in plain English</h2>
    <p style="font-family:var(--serif);font-size:19px;margin:0 0 18px;max-width:520px">The Index explains the terms that show up in Prompted and counts how many issues mention each one.</p>
    <a class="btn ghost" href="/index/">Open the Index</a>
  </div>
  <div class="card"><h2>Get Prompted every Monday</h2><p>Join students, founders and faculty who read it to start the week.</p>${signupForm('home-footer')}</div>
</div></section>`;
  return layout(site, { title: `${site.name} — ${site.tagline}`, description: site.description, pathName: '/', body,
    jsonLd: { '@context': 'https://schema.org', '@type': 'WebSite', name: site.name, url: site.url + '/', description: site.description } });
}

function archivePage(site, issues) {
  const byYear = new Map();
  for (const i of [...issues].reverse()) { const y = i.week.end.slice(0, 4); if (!byYear.has(y)) byYear.set(y, []); byYear.get(y).push(i); }
  const body = `<div class="wrap"><div class="prose" style="max-width:820px">
  <h1>Archive</h1>
  <p style="color:var(--muted);margin:0 0 18px">Every issue of ${esc(site.name)}, newest first.</p>
  <label class="vh" for="q">Search the archive</label>
  <input id="q" class="search" type="search" placeholder="Search every issue" data-search="/data/search.json" autocomplete="off">
  <p class="count" data-count aria-live="polite">${issues.length} issues</p>
  ${[...byYear].map(([y, list]) => `<p class="year" data-year>${y}</p><ul class="issue-list">${list.map(issueLi).join('')}</ul>`).join('\n')}
</div></div>`;
  return layout(site, { title: `Archive — ${site.name}`, description: `All ${issues.length} issues of ${site.name}, searchable.`, pathName: '/issues/', body, current: 'issues' });
}

function issuePage(site, issue, issues, indexData) {
  const { html, toc } = renderIssueWeb(issue);
  const prev = issues[issue.number - 2], next = issues[issue.number];
  const terms = indexData ? termsInIssue(issue, indexData) : [];
  const url = site.url + issueUrl(issue);
  const share = encodeURIComponent(url);
  // Soft gate: split after N blocks. Everything stays in the HTML (and readable without JavaScript).
  const parts = html.split('\n');
  const gated = site.gate === 'soft' && parts.length > site.gate_after_blocks + 4;
  const head = gated ? parts.slice(0, site.gate_after_blocks).join('\n') : html;
  const rest = gated ? parts.slice(site.gate_after_blocks).join('\n') : '';
  const body = `<div class="progress" aria-hidden="true"><i></i></div><div class="wrap">
${renderMasthead(issue, site)}
<p class="meta"><span>No. ${issue.number}</span><span>Week of ${esc(issue.week.label)}</span><span>${readMinutes(issue)} min read</span><span>By ${esc(site.author)}</span></p>
<details class="toc"><summary>In this issue</summary><ol>${toc.map((t) => `<li class="l${t.level}"><a href="#${t.id}">${esc(t.text)}</a></li>`).join('')}</ol></details>
<div class="issue-layout">
<nav class="toc-side" aria-label="In this issue"><p>In this issue</p><ol>${toc.map((t) => `<li class="l${t.level}"><a href="#${t.id}">${esc(t.text)}</a></li>`).join('')}</ol></nav>
<article class="issue">
<h1>${esc(issue.title)}</h1>
${head}
${gated ? `<div class="gate card" data-gate hidden><h2>Keep reading. It is free.</h2><p>Enter your email to get ${esc(site.name)} every Monday morning.</p>${signupForm('issue-gate')}<button class="skip-gate" type="button">I already subscribe. Continue reading.</button></div>
<div data-gated>
${rest}
</div>` : ''}
</article>
</div>
<div class="after">
  ${terms.length ? `<section class="terms" aria-labelledby="terms-h"><h2 id="terms-h">Terms from this issue in the Prompted Index</h2><div class="chips">${terms.map((t) => `<a href="/index/#${encodeURIComponent(t.anchor)}">${esc(t.term)}</a>`).join('')}</div></section>` : ''}
  <div class="share"><span>Share:</span><a href="https://www.linkedin.com/sharing/share-offsite/?url=${share}" rel="noopener">LinkedIn</a><a href="mailto:?subject=${encodeURIComponent(issue.title)}&body=${share}">Email</a><a href="${esc(url)}">Permalink</a></div>
  <div class="card"><h2>Get the next issue in your inbox</h2><p>${esc(site.name)} is free and arrives ${esc(site.send_slot_label)}.</p>${signupForm('issue-end')}</div>
  <nav class="pager" aria-label="Issues">${prev ? `<a href="${issueUrl(prev)}"><small>← Previous</small>Week of ${esc(prev.week.label)}</a>` : '<span></span>'}${next ? `<a class="next" href="${issueUrl(next)}"><small>Next →</small>Week of ${esc(next.week.label)}</a>` : '<span></span>'}</nav>
</div>
</div>`;
  return layout(site, { title: issue.title, description: issue.subtitle, pathName: issueUrl(issue), body, current: 'issues', ogType: 'article',
    jsonLd: { '@context': 'https://schema.org', '@type': 'NewsArticle', headline: issue.title, description: issue.subtitle, datePublished: issue.publication.date, author: { '@type': 'Person', name: site.author }, publisher: { '@type': 'Organization', name: site.name }, mainEntityOfPage: url, isAccessibleForFree: true } });
}

function subscribePage(site, issues) {
  const latest = issues.at(-1);
  const body = `<div class="wrap"><div class="prose" style="text-align:center;padding-bottom:20px">
  <h1>Subscribe to ${esc(site.name)}</h1>
  <p style="font-family:var(--serif);font-size:21px;margin:0 0 22px">${esc(site.promise)}</p>
  ${signupForm('subscribe-page')}
  <p class="fine">Free. One email, ${esc(site.send_slot_label)}. Unsubscribe any time with one click.</p>
</div>
<div class="grid three who" style="max-width:860px;margin:0 auto 20px;text-align:left">
  <div class="card"><h3>What arrives</h3><p>One issue a week: the biggest developments, what they add up to, and what they mean for you.</p></div>
  <div class="card"><h3>What does not</h3><p>No ads, no sponsored links, no daily mail. Your address is never shared.</p></div>
  <div class="card"><h3>Try before you sign up</h3><p><a href="${issueUrl(latest)}">Read the latest issue</a> or browse <a href="/issues/">all ${issues.length}</a>.</p></div>
</div></div>`;
  return layout(site, { title: `Subscribe — ${site.name}`, description: site.description, pathName: '/subscribe/', body });
}

const simplePage = (site, pathName, title, inner) => layout(site, { title: `${title} — ${site.name}`, description: site.description, pathName, body: `<div class="wrap"><div class="prose"><h1>${esc(title)}</h1>${inner}</div></div>` });

const redirectPage = (to) => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Prompted</title><meta name="robots" content="noindex"><link rel="canonical" href="${esc(to)}"><meta http-equiv="refresh" content="0; url=${esc(to)}"><script>location.replace(${JSON.stringify(to)}+location.hash)</script></head><body><p><a href="${esc(to)}">Continue</a></p></body></html>`;

async function out(rel, content) {
  const file = path.join(DIST, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

export async function build(env = process.env) {
  const site = await loadSite(env);
  const issues = await loadIssues();
  let indexData = null;
  try { indexData = JSON.parse(await readFile(path.join(REPO, 'index', 'data.json'), 'utf8')); } catch { console.warn('Index data not found; issue pages will not show Index terms.'); }

  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
  await cp(path.join(ROOT, 'static'), DIST, { recursive: true });
  await out('assets/styles.css', await readFile(path.join(ROOT, 'src', 'site', 'styles.css')));
  await out('assets/site.js', await readFile(path.join(ROOT, 'src', 'site', 'site.js')));
  await cp(path.join(ROOT, 'admin'), path.join(DIST, 'admin'), { recursive: true });

  await out('index.html', homePage(site, issues));
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

  for (const c of site.campaigns) await out(`s/${c.code}/index.html`, redirectPage(`/subscribe/?utm_source=${encodeURIComponent(c.utm_source)}&utm_medium=${encodeURIComponent(c.utm_medium)}&utm_campaign=${encodeURIComponent(c.utm_campaign)}`));

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
  await out('robots.txt', site.env === 'production' ? `User-agent: *\nAllow: /\nDisallow: /admin/\nDisallow: /email/\nSitemap: ${site.url}/sitemap.xml\n` : 'User-agent: *\nDisallow: /\n');
  return { site, issues: issues.length, indexTerms: indexData?.terms?.length ?? 0 };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  build().then((r) => console.log(`Built ${r.issues} issues (${r.site.env}, ${r.site.url}); Index terms available: ${r.indexTerms}`)).catch((e) => { console.error(e); process.exit(1); });
}
