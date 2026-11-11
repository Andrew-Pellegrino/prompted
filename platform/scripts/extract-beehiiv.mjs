#!/usr/bin/env node
// Migration: beehiiv public web posts -> canonical issue JSON (platform/content/issues).
//
// Repeatable and idempotent: re-running with the same inputs rewrites byte-identical files.
// Reads only PUBLIC pages (no credentials, no subscriber data).
//
//   node scripts/extract-beehiiv.mjs --fetch            # download pages into .cache/beehiiv, then extract
//   node scripts/extract-beehiiv.mjs --html-dir <dir>   # extract from already-downloaded pages
//
// Fidelity rule: editorial text is copied verbatim. The script fails if the text of the
// extracted blocks does not equal the text of the source content region.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWeekLabel, slugForWeek } from '../src/lib/weeks.mjs';
import { blocksText, validateIssue } from '../src/lib/issue-model.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'content', 'beehiiv-posts.json');
const OUT = path.join(ROOT, 'content', 'issues');
const BASE = 'https://readprompted.beehiiv.com/p/';

const VOID = new Set(['img', 'br', 'hr', 'meta', 'link', 'input', 'path', 'source', 'wbr', 'area', 'col', 'embed', 'track']);
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return e.toLowerCase() in ENT ? ENT[e.toLowerCase()] : m;
  });
const attr = (raw, name) => {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(raw);
  return m ? decode(m[2] ?? m[3]) : null;
};

/** Tokenise the #content-blocks region into tags and text. */
export function contentRegion(html) {
  const at = html.indexOf('id="content-blocks"');
  if (at < 0) throw new Error('content-blocks region not found');
  const start = html.lastIndexOf('<', at);
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  re.lastIndex = start;
  const tokens = [];
  let depth = 0, last = start, m;
  while ((m = re.exec(html))) {
    if (m.index > last) tokens.push({ text: decode(html.slice(last, m.index)) });
    last = re.lastIndex;
    if (!m[2]) continue; // comment
    const tag = m[2].toLowerCase();
    const close = m[1] === '/';
    const selfClosing = VOID.has(tag) || /\/\s*$/.test(m[3]);
    tokens.push({ tag, close, raw: m[3], selfClosing });
    if (!selfClosing) depth += close ? -1 : 1;
    if (depth === 0) break;
  }
  return tokens;
}

const BLOCK = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'li', 'blockquote']);

/** Build generic blocks from the token stream. */
export function buildBlocks(tokens) {
  const blocks = [];
  let cur = null;
  const marks = [];
  let list = null;
  const pushText = (text) => {
    if (!cur || !text) return;
    const run = { text };
    for (const mk of marks) {
      if (mk.bold) run.bold = true;
      if (mk.italic) run.italic = true;
      if (mk.underline) run.underline = true;
      if (mk.href) run.href = mk.href;
    }
    const prev = cur.children.at(-1);
    if (prev && prev.bold === run.bold && prev.italic === run.italic && prev.underline === run.underline && prev.href === run.href) prev.text += text;
    else cur.children.push(run);
  };
  for (const t of tokens) {
    if (t.text !== undefined) { pushText(t.text); continue; }
    const { tag, close, raw } = t;
    if (tag === 'img' && !cur) { blocks.push({ type: 'image', src: attr(raw, 'src'), alt: attr(raw, 'alt') || '' }); continue; }
    if (tag === 'hr') { blocks.push({ type: 'divider' }); continue; }
    if (tag === 'br') { pushText('\n'); continue; }
    if (tag === 'ul' || tag === 'ol') {
      if (!close) { list = { type: 'list', ordered: tag === 'ol', items: [] }; blocks.push(list); } else list = null;
      continue;
    }
    if (BLOCK.has(tag)) {
      if (!close) {
        if (cur) continue; // nested block inside a block (e.g. <p> in <li>): keep one logical block
        const style = attr(raw, 'style') || '';
        cur = tag[0] === 'h' ? { type: 'heading', level: Number(tag[1]), children: [] }
          : tag === 'blockquote' ? { type: 'quote', children: [] }
          : { type: tag === 'li' ? 'item' : 'paragraph', children: [] };
        if (/text-align:\s*center/.test(style)) cur.align = 'center';
        cur._tag = tag;
      } else if (cur && cur._tag === tag) {
        delete cur._tag;
        if (cur.type === 'item') { if (list) list.items.push(cur.children); else blocks.push({ type: 'paragraph', children: cur.children }); }
        else blocks.push(cur);
        cur = null;
      }
      continue;
    }
    if (!cur || t.selfClosing) continue;
    if (close) {
      for (let i = marks.length - 1; i >= 0; i--) if (marks[i].tag === tag) { marks.splice(i, 1); break; }
      continue;
    }
    const mk = { tag };
    const style = attr(raw, 'style') || '';
    if (tag === 'strong' || tag === 'b') mk.bold = true;
    if (tag === 'em' || tag === 'i') mk.italic = true;
    if (tag === 'u') mk.underline = true;
    if (tag === 'a') mk.href = attr(raw, 'href') || '';
    // Bold/italic expressed only through inline style is recorded for inline spans inside
    // paragraphs. Headings carry their own weight, so style-weight there is not a mark.
    if (tag === 'span' && cur.type === 'paragraph') {
      if (/font-weight:\s*(700|bold)/.test(style)) mk.bold = true;
      if (/font-style:\s*italic/.test(style)) mk.italic = true;
    }
    marks.push(mk);
  }
  return blocks;
}

const norm = (s) => s.replace(/[\s ]+/g, ' ').trim();
const textOf = (children) => children.map((c) => c.text).join('');

/** Assign roles, drop presentation-only chrome (recorded in `legacy`), tidy heading runs. */
export function normalise(blocks) {
  const legacy = { header_images: [], dropped_empty_paragraphs: 0, forward_cta: null };
  const out = [];
  let seenText = false;
  for (const b of blocks) {
    if (b.type === 'image' && !seenText) { legacy.header_images.push(b.src); continue; }
    if ((b.type === 'paragraph' || b.type === 'heading') && norm(textOf(b.children)) === '') { legacy.dropped_empty_paragraphs++; continue; }
    if (b.type === 'heading') {
      // Headings are bold by definition; keep only italic/links as inline marks.
      b.children = b.children.map(({ bold, ...r }) => r).reduce((acc, r) => {
        const p = acc.at(-1);
        if (p && p.italic === r.italic && p.href === r.href && p.underline === r.underline) p.text += r.text; else acc.push(r);
        return acc;
      }, []);
    }
    if (b.type === 'paragraph') {
      const t = norm(textOf(b.children));
      if (/^Forwarded this by a friend\?/.test(t)) { legacy.forward_cta = t; continue; }
      if (/^That[’']s the week\. See you next Monday\.$/.test(t)) b.role = 'closing';
      else if (/^— Prompted$/.test(t)) b.role = 'signoff';
      else if (!seenText) b.role = 'opening';
    }
    seenText = true;
    if (b.align !== 'center') delete b.align;
    out.push(b);
  }
  return { blocks: out, legacy };
}

const meta = (html, prop) => {
  const m = new RegExp(`<meta[^>]+(?:property|name)="${prop}"[^>]+content="([^"]*)"`, 'i').exec(html)
    || new RegExp(`<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="${prop}"`, 'i').exec(html);
  return m ? decode(m[1]) : null;
};

export function extractIssue(html, post) {
  const tokens = contentRegion(html);
  const raw = buildBlocks(tokens);
  const { blocks, legacy } = normalise(raw);
  // Independent fidelity check: all text in the region vs all text in generic blocks.
  const regionText = norm(tokens.filter((t) => t.text !== undefined).map((t) => t.text).join(''));
  const blockText = norm(raw.map((b) => (b.type === 'list' ? b.items.map(textOf).join('') : b.children ? textOf(b.children) : '')).join(''));
  if (regionText.replace(/ /g, '') !== blockText.replace(/ /g, '')) throw new Error(`${post.slug}: text fidelity check failed`);
  const label = post.title.replace(/^Prompted\s+—\s+Week of\s+/, '');
  const week = parseWeekLabel(label);
  const subtitle = meta(html, 'og:description') || meta(html, 'description') || '';
  const sent = post.email_sent_at || null;
  const issue = {
    schema: 'prompted-issue-1',
    slug: slugForWeek(week),
    title: `Prompted — Week of ${week.label}`,
    week,
    subtitle,
    publication: sent
      ? { date: sent.slice(0, 10), basis: 'beehiiv_email_send', sent_at: sent }
      : { date: week.nominal_send_date, basis: 'derived_monday_after_week', note: 'Published before Prompted moved to beehiiv; exact original send time is not recorded in beehiiv.' },
    source: {
      system: 'beehiiv',
      post_id: post.id,
      slug: post.slug,
      url: BASE + post.slug,
      beehiiv_published_at: post.published_at,
      backfilled_to_beehiiv: !sent,
      content_sha256: createHash('sha256').update(blocksText(blocks)).digest('hex'),
    },
    legacy,
    blocks,
  };
  validateIssue(issue);
  return issue;
}

async function main() {
  const args = process.argv.slice(2);
  const posts = JSON.parse(await readFile(MANIFEST, 'utf8')).posts;
  let dir = args.includes('--html-dir') ? args[args.indexOf('--html-dir') + 1] : path.join(ROOT, '.cache', 'beehiiv');
  if (args.includes('--fetch')) {
    await mkdir(dir, { recursive: true });
    for (const p of posts) {
      const res = await fetch(BASE + p.slug, { headers: { 'user-agent': 'Mozilla/5.0 (PromptedMigration)' } });
      if (!res.ok) throw new Error(`${p.slug}: HTTP ${res.status}`);
      await writeFile(path.join(dir, p.slug + '.html'), await res.text());
    }
  }
  if (!existsSync(dir)) throw new Error(`No HTML directory at ${dir}. Use --fetch or --html-dir.`);
  await mkdir(OUT, { recursive: true });
  const issues = [];
  for (const p of posts) issues.push(extractIssue(await readFile(path.join(dir, p.slug + '.html'), 'utf8'), p));
  issues.sort((a, b) => a.week.end.localeCompare(b.week.end));
  const report = [];
  for (const [i, issue] of issues.entries()) {
    const ordered = { number: i + 1, ...issue };
    await writeFile(path.join(OUT, `${String(i + 1).padStart(3, '0')}-${issue.slug}.json`), JSON.stringify(ordered, null, 1) + '\n');
    const text = blocksText(issue.blocks);
    report.push({
      n: i + 1, week: issue.week.label, words: text.split(/\s+/).length,
      h2: issue.blocks.filter((b) => b.type === 'heading' && b.level === 2).length,
      h3: issue.blocks.filter((b) => b.type === 'heading' && b.level === 3).length,
      p: issue.blocks.filter((b) => b.type === 'paragraph').length,
      links: issue.blocks.flatMap((b) => b.children || []).filter((c) => c.href).length,
      other: issue.blocks.filter((b) => !['heading', 'paragraph'].includes(b.type)).map((b) => b.type).join(',') || '-',
      closing: issue.blocks.some((b) => b.role === 'closing') && issue.blocks.some((b) => b.role === 'signoff'),
      sha: issue.source.content_sha256.slice(0, 12),
    });
  }
  const stale = (await readdir(OUT)).filter((f) => !issues.some((x, i) => f === `${String(i + 1).padStart(3, '0')}-${x.slug}.json`));
  console.table(report);
  if (stale.length) console.warn('Files in content/issues not produced by this run:', stale);
  console.log(`Extracted ${issues.length} issues; text fidelity check passed for all.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(1); });
