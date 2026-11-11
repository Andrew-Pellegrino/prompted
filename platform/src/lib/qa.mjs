// Automated pre-send QA. Returns findings; "error" blocks approval, "warn" needs a human look.
import { CLOSING_LINE, SIGNOFF_LINE, SECTION_ORDER, runsText, sections, wordCount, blocksText } from './issue-model.mjs';
import { renderIssueEmail, EMAIL_WIDTH } from './render-email.mjs';
import { renderIssueWeb } from './render-web.mjs';
import { mastheadWeek, scheduledSendFor } from './weeks.mjs';

const strip = (html) => html.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&(amp|lt|gt|quot|#39|nbsp|zwnj|#847);/g, (m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ', zwnj: '', '#847': '' }[e]));
const squash = (s) => s.replace(/\s+/g, '');

/**
 * @param issue  canonical issue
 * @param site   site config
 * @param ctx    { strict: true for new issues (house format enforced), indexAnchors: Set of live Index anchors }
 */
export function runQA(issue, site, ctx = {}) {
  const f = [];
  const add = (level, code, message) => f.push({ level, code, message });
  const strict = ctx.strict !== false;
  const secs = sections(issue);
  const titles = secs.slice(1).map((s) => s.title);

  // Structure and house format
  if (issue.blocks[0]?.role !== 'opening') add('error', 'opening', 'The issue must start with a single opening paragraph.');
  if (secs[0].blocks.filter((b) => b.type === 'paragraph').length > 1) add(strict ? 'error' : 'warn', 'opening-split', 'The opening must stay one paragraph.');
  const missing = SECTION_ORDER.filter((s) => !titles.includes(s));
  if (missing.length) add(strict ? 'error' : 'warn', 'sections-missing', `Missing section(s): ${missing.join(', ')}.`);
  const known = titles.filter((t) => SECTION_ORDER.includes(t));
  if (known.join('|') !== SECTION_ORDER.filter((s) => known.includes(s)).join('|')) add('error', 'sections-order', `Sections are out of order: ${titles.join(' > ')}.`);
  const extra = titles.filter((t) => !SECTION_ORDER.includes(t));
  if (extra.length) add('warn', 'sections-extra', `Unexpected section heading(s): ${extra.join(', ')}.`);
  const closing = issue.blocks.find((b) => b.role === 'closing'), signoff = issue.blocks.find((b) => b.role === 'signoff');
  if (!closing || runsText(closing.children).trim() !== CLOSING_LINE) add(strict ? 'error' : 'warn', 'closing', `Closing line must be exactly “${CLOSING_LINE}”.`);
  if (!signoff || runsText(signoff.children).trim() !== SIGNOFF_LINE) add(strict ? 'error' : 'warn', 'signoff', `Sign-off must be exactly “${SIGNOFF_LINE}”.`);
  if (closing && signoff && issue.blocks.indexOf(signoff) !== issue.blocks.length - 1) add('error', 'signoff-last', 'The sign-off must be the last block.');

  // Dates
  const span = (new Date(issue.week.end) - new Date(issue.week.start)) / 864e5;
  if (span < 6 || span > 7) add('warn', 'week-span', `Week spans ${span} days.`);
  if (!issue.title.includes(issue.week.label)) add('error', 'title-week', 'Title does not contain the week label.');
  const send = scheduledSendFor(issue.week);
  if (new Date(send.utc).getUTCDay() !== 1) add('error', 'send-day', 'Scheduled send is not a Monday.');

  // Links
  const linkRuns = issue.blocks.flatMap((b) => (b.type === 'list' ? b.items.flat() : b.children || [])).filter((r) => r.href !== undefined);
  for (const r of linkRuns) {
    if (!/^https:\/\//.test(r.href)) add(/^http:\/\//.test(r.href) ? 'warn' : 'error', 'link-scheme', `Link “${r.text.trim()}” is not https: ${r.href}`);
    if (/beehiiv\.com/.test(r.href)) add('warn', 'link-beehiiv', `Link “${r.text.trim()}” still points to beehiiv: ${r.href}`);
    if (!r.text.trim()) add('error', 'link-empty', `A link has no visible text: ${r.href}`);
    const m = /\/index\/#(.+)$/.exec(r.href);
    if (m && ctx.indexAnchors && !ctx.indexAnchors.has(decodeURIComponent(m[1]))) add('error', 'index-anchor', `Index link “${r.text.trim()}” points to an anchor that is not on the live Index: #${m[1]}`);
  }
  for (const b of issue.blocks) if (b.type === 'image' && !b.alt.trim()) add('warn', 'image-alt', `Image has no alt text: ${b.src}`);

  // Style signals from the production spec (review prompts, not hard rules)
  const text = blocksText(issue.blocks);
  const semis = (text.match(/;/g) || []).length;
  if (strict && semis) add('warn', 'semicolons', `${semis} semicolon(s): each needs the two-sentence test.`);
  const wc = wordCount(issue);
  if (strict && wc > 4300) add('warn', 'length', `${wc} words: run the compression review.`);
  if (/\bhttps?:\/\/\S+/.test(text)) add('warn', 'raw-url', 'A raw URL appears in the reader-facing text.');

  // Rendering parity: web and email must carry exactly the same words as the source.
  const email = renderIssueEmail(issue, site);
  const web = renderIssueWeb(issue);
  const src = squash(text);
  if (!squash(strip(web.html)).includes(src) && squash(strip(web.html)) !== src) add('error', 'web-drift', 'Web rendering does not match the approved text.');
  const bodyStart = email.html.indexOf('<td class="pad" style="padding:22px');
  const bodyEnd = email.html.indexOf('</td></tr>', bodyStart);
  if (squash(strip(email.html.slice(bodyStart, bodyEnd))) !== src) add('error', 'email-drift', 'Email rendering does not match the approved text.');

  // Email structure
  if (!email.html.includes(mastheadWeek(issue.week))) add('error', 'email-week', 'Email masthead is missing the week line.');
  if (!email.html.includes('{{UNSUBSCRIBE_URL}}') || !email.text.includes('{{UNSUBSCRIBE_URL}}')) add('error', 'email-unsub', 'Unsubscribe link missing from the email.');
  if (!site.postal_address || /TODO|TBD/i.test(site.postal_address)) add('error', 'email-address', 'A postal address is required in the footer before any real send (CAN-SPAM).');
  if (/example|not a real address|preview only/i.test(site.postal_address || '')) add('warn', 'email-address-placeholder', 'The footer address is a placeholder. Replace it with the approved address before sending to real inboxes.');
  if (!email.html.includes(`max-width:${EMAIL_WIDTH}px`)) add('error', 'email-width', 'Email content width changed.');
  for (const m of email.html.matchAll(/<img[^>]+>/g)) {
    if (!/alt="/.test(m[0])) add('error', 'email-img-alt', 'Email image without alt attribute.');
    if (!/src="https:\/\//.test(m[0]) && !/src="\{\{/.test(m[0])) add('error', 'email-img-src', `Email image is not an absolute https URL: ${m[0].slice(0, 80)}`);
  }
  const kb = Math.round(new TextEncoder().encode(email.html).length / 1024);
  if (kb > 102) add('warn', 'email-size', `Email HTML is ${kb} KB; Gmail clips messages over 102 KB.`);
  if (!email.subject.trim()) add('error', 'email-subject', 'Subject is empty.');
  if (email.preview.length > 140) add('warn', 'email-preview', 'Preview text is longer than 140 characters and will be cut off.');

  return { ok: !f.some((x) => x.level === 'error'), errors: f.filter((x) => x.level === 'error').length, warnings: f.filter((x) => x.level === 'warn').length, findings: f, stats: { words: wc, email_kb: kb, links: linkRuns.length, send } };
}
