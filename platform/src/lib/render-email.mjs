// Issue -> email HTML + plain text. Table layout, inline styles, 608px content width, Arial.
// The masthead and week line are live text; only the institutional lockup is an image.
//
// Per-recipient values are left as placeholders so one rendered body can be sent to everyone:
//   {{UNSUBSCRIBE_URL}}  {{WEB_URL}}  {{OPEN_PIXEL}}  {{TOKEN}}  {{TRACK}} (the per-send tracking id inside tracked URLs)
// fillRecipient() substitutes them. Editorial wording is never altered.
import { esc, renderRuns } from './html.mjs';
import { blockText, runsText } from './issue-model.mjs';
import { mastheadWeek } from './weeks.mjs';

export const EMAIL_WIDTH = 608;
const FONT = 'Arial, Helvetica, sans-serif';
const C = { ink: '#000000', mast: '#111111', sub: '#2b3440', red: '#c3142d', rule: '#bfbfbf', closeRule: '#808080', muted: '#5f5e58', link: '#c3142d' };
const P = `margin:0 0 14px 0;font-family:${FONT};font-size:16px;line-height:1.55;color:${C.ink};`;

const makeLink = (track) => (href) => ({ href: track ? track(href) : href, attrs: { style: `color:${C.link};text-decoration:underline;`, target: '_blank' } });

function block(b, link) {
  switch (b.type) {
    case 'heading':
      return b.level === 2
        ? `<h2 style="margin:26px 0 12px 0;padding:0 0 6px 0;border-bottom:1px solid ${C.rule};font-family:${FONT};font-size:20px;line-height:1.25;font-weight:bold;color:${C.ink};">${renderRuns(b.children, { link })}</h2>`
        : `<h3 style="margin:20px 0 6px 0;font-family:${FONT};font-size:17px;line-height:1.3;font-weight:bold;color:${C.ink};">${renderRuns(b.children, { link })}</h3>`;
    case 'paragraph':
      if (b.role === 'closing') return `<p style="${P}margin:26px 0 0 0;padding-top:16px;border-top:1px solid ${C.closeRule};">${renderRuns(b.children, { link })}</p>`;
      if (b.role === 'signoff') return `<p style="${P}margin:4px 0 0 0;font-style:italic;">${renderRuns(b.children.map(({ italic, ...r }) => r), { link })}</p>`;
      return `<p style="${P}${b.align === 'center' ? 'text-align:center;' : ''}">${renderRuns(b.children, { link })}</p>`;
    case 'quote': return `<blockquote style="margin:0 0 14px 0;padding:0 0 0 14px;border-left:3px solid ${C.rule};"><p style="${P}margin:0;">${renderRuns(b.children, { link })}</p></blockquote>`;
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      return `<${tag} style="margin:0 0 14px 0;padding:0 0 0 24px;font-family:${FONT};font-size:16px;line-height:1.55;color:${C.ink};">${b.items.map((it) => `<li style="margin:0 0 6px 0;">${renderRuns(it, { link })}</li>`).join('')}</${tag}>`;
    }
    case 'image': return `<p style="margin:0 0 14px 0;"><img src="${esc(b.src)}" alt="${esc(b.alt)}" width="${EMAIL_WIDTH - 48}" style="display:block;width:100%;max-width:${EMAIL_WIDTH - 48}px;height:auto;border:0;"></p>`;
    case 'divider': return `<hr style="border:0;border-top:1px solid ${C.rule};margin:20px 0;">`;
    default: throw new Error(`render-email: unknown block ${b.type}`);
  }
}

/**
 * Optional "In the Prompted Index" block: a few term names, each linking to its Index entry. It only
 * names terms; it does not add, change or reorder any editorial text. Off unless a send asks for it.
 */
function indexTermsBlock(terms, tl) {
  const links = terms.map((t) => `<a href="${esc(tl(t.url))}" style="color:${C.link};text-decoration:underline;">${esc(t.term)}</a>`).join(`<span style="color:${C.muted};"> &middot; </span>`);
  return `<tr><td class="pad" style="padding:8px 24px 0 24px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid ${C.rule};padding:12px 0 2px 0;">
<p style="margin:0 0 4px 0;font-family:${FONT};font-size:12px;line-height:1.4;font-weight:bold;letter-spacing:0.06em;text-transform:uppercase;color:${C.sub};">In the Prompted Index</p>
<p style="margin:0;font-family:${FONT};font-size:15px;line-height:1.6;color:${C.ink};">${links}</p>
</td></tr></table>
</td></tr>`;
}

/** Subject and preview text derive from the issue; both can be overridden per send. */
// Matches the established subject line: "Prompted | Your Weekly AI Brief | Week of November 1–8".
export const emailSubject = (issue, site) => `${site.name} | ${site.tagline} | ${mastheadWeek(issue.week)}`;
export const emailPreview = (issue) => issue.subtitle || '';

export function renderIssueEmail(issue, site, opts = {}) {
  const subject = opts.subject || emailSubject(issue, site);
  const preview = opts.preview ?? emailPreview(issue);
  // opts.trackLink(href) may return a redirect URL (click tracking); visible text is never changed.
  const link = makeLink(opts.trackLink);
  const tl = (href) => (opts.trackLink ? opts.trackLink(href) : href); // template links are tracked the same way
  const terms = opts.indexTerms || [];
  const assets = site.asset_base_url.replace(/\/$/, '');
  const cell = `padding:0 24px;`;
  const centre = (style, text) => `<tr><td align="center" style="${cell}font-family:${FONT};${style}">${text}</td></tr>`;
  const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(subject)}</title>
<style>
body{margin:0;padding:0;background:#ffffff;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
table{border-collapse:collapse}
img{-ms-interpolation-mode:bicubic}
a{color:${C.link}}
@media only screen and (max-width:640px){
  .wrap{width:100%!important}
  .pad{padding-left:16px!important;padding-right:16px!important}
  .mast{font-size:44px!important}
}
</style>
</head>
<body style="margin:0;padding:0;background:#ffffff;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#ffffff;opacity:0;">${esc(preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;">
<tr><td align="center" style="padding:0;">
<!--[if mso]><table role="presentation" width="${EMAIL_WIDTH}" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td><![endif]-->
<table role="presentation" class="wrap" width="${EMAIL_WIDTH}" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:${EMAIL_WIDTH}px;background:#ffffff;">
<tr><td align="center" style="padding:20px 24px 8px 24px;"><img src="${esc(assets)}/img/miami-altman-lockup.png" width="80" height="64" alt="Miami University, John W. Altman Institute for Entrepreneurship" style="display:block;border:0;width:80px;height:64px;"></td></tr>
${centre(`font-size:52px;line-height:1.1;font-weight:bold;color:${C.mast};padding-top:6px;padding-bottom:14px;" class="mast`, esc(site.name))}
${centre(`font-size:15px;line-height:1.4;font-style:italic;color:${C.sub};padding-bottom:4px;`, esc(site.tagline))}
${centre(`font-size:15px;line-height:1.4;color:${C.sub};padding-bottom:4px;`, esc(mastheadWeek(issue.week)))}
${centre(`font-size:15px;line-height:1.4;color:${C.sub};padding-bottom:18px;`, esc(site.attribution))}
<tr><td class="pad" style="padding:0 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td height="3" style="height:3px;line-height:3px;font-size:3px;background:${C.red};">&nbsp;</td></tr></table></td></tr>
<tr><td class="pad" style="padding:22px 24px 8px 24px;">
${issue.blocks.map((b) => block(b, link)).join('\n')}
</td></tr>
${terms.length ? indexTermsBlock(terms, tl) : ''}
<tr><td class="pad" style="padding:18px 24px 0 24px;">
<p style="margin:0 0 10px 0;font-family:${FONT};font-size:14px;line-height:1.5;font-style:italic;color:${C.ink};">Forwarded this by a friend? ${esc(site.name)} is free and arrives every Monday morning. <a href="${esc(tl(site.forward_subscribe_url))}" style="color:${C.link};">Subscribe here</a>.</p>
<p style="margin:0 0 10px 0;font-family:${FONT};font-size:14px;line-height:1.5;color:${C.ink};">Look up any term in the <a href="${esc(tl(site.index_url))}" style="color:${C.link};">Prompted Index</a>. Read this issue <a href="{{WEB_URL}}" style="color:${C.link};">on the web</a>.</p>
</td></tr>
<tr><td class="pad" style="padding:18px 24px 28px 24px;border-top:1px solid #e3e1da;">
<p style="margin:0 0 6px 0;font-family:${FONT};font-size:12px;line-height:1.5;color:${C.muted};">You are receiving this because you subscribed to ${esc(site.name)}. <a href="{{UNSUBSCRIBE_URL}}" style="color:${C.muted};text-decoration:underline;">Unsubscribe</a> at any time.</p>
<p style="margin:0;font-family:${FONT};font-size:12px;line-height:1.5;color:${C.muted};">${esc(site.name)} · ${esc(site.postal_address)}</p>
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
{{OPEN_PIXEL}}
</body>
</html>`;
  return { subject, preview, html, text: renderIssueText(issue, site, terms) };
}

/** Plain-text alternative part. */
export function renderIssueText(issue, site, terms = []) {
  const out = [site.name, site.tagline, mastheadWeek(issue.week), site.attribution, '='.repeat(40), ''];
  for (const b of issue.blocks) {
    if (b.type === 'heading') {
      const t = runsText(b.children).trim();
      out.push('', b.level === 2 ? t.toUpperCase() : t, b.level === 2 ? '-'.repeat(Math.min(40, t.length)) : '');
    } else if (b.type === 'list') b.items.forEach((it, i) => out.push(`${b.ordered ? i + 1 + '.' : '-'} ${runsText(it)}`));
    else if (b.type === 'image') out.push(`[${b.alt || 'image'}]`, '');
    else if (b.type === 'divider') out.push('-'.repeat(20), '');
    else {
      const links = (b.children || []).filter((r) => r.href).map((r) => `${r.text.trim()}: ${r.href}`);
      out.push(blockText(b) + (links.length ? `\n(${links.join(' | ')})` : ''), '');
    }
  }
  if (terms.length) out.push('In the Prompted Index:', ...terms.map((t) => `- ${t.term}: ${t.url}`), '');
  out.push('-'.repeat(40), `Forwarded this by a friend? Subscribe: ${site.forward_subscribe_url}`, `Prompted Index: ${site.index_url}`, 'Read on the web: {{WEB_URL}}', '',
    `Unsubscribe: {{UNSUBSCRIBE_URL}}`, `${site.name} · ${site.postal_address}`);
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Substitute per-recipient placeholders. Pass html=false for the plain-text part. */
export function fillRecipient(body, { unsubscribeUrl, webUrl, openPixelUrl, token = '', track = '' }, html = true) {
  const e = html ? esc : (x) => x;
  return body
    .replaceAll('{{TOKEN}}', e(token))
    .replaceAll('{{UNSUBSCRIBE_URL}}', e(unsubscribeUrl))
    .replaceAll('{{WEB_URL}}', e(webUrl))
    .replaceAll('{{OPEN_PIXEL}}', openPixelUrl ? `<img src="${esc(openPixelUrl)}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px;">` : '')
    .replaceAll('{{TRACK}}', e(track)); // last, so tracked URLs placed above are filled too
}

/**
 * Every link a send may track, in a stable order: links in the issue text (labelled with their visible
 * words), then the template's links, then any Index terms. The unsubscribe link is never tracked.
 */
export function emailLinks(issue, site, webUrl, indexTerms = []) {
  const out = [], seen = new Set();
  const add = (url, label, kind) => { if (!url || seen.has(url) || !/^https?:\/\//.test(url)) return; seen.add(url); out.push({ url, label, kind }); };
  const runs = issue.blocks.flatMap((b) => (b.type === 'list' ? b.items.flat() : b.children || []));
  for (const r of runs) if (r.href) add(r.href, String(r.text || '').trim().slice(0, 120) || r.href, 'body');
  add(webUrl, 'Read on the web', 'template');
  add(site.index_url, 'Prompted Index (footer)', 'template');
  add(site.forward_subscribe_url, 'Subscribe link for forwarded copies', 'template');
  for (const t of indexTerms) add(t.url, t.term, 'index_term');
  return out;
}
