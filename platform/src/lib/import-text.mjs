// Approved issue text -> canonical issue. The input is the approved wording in a minimal,
// Markdown-like form; nothing is reworded, reordered or summarised.
//
//   # Week of November 8–15, 2026          (required first line)
//   > One-sentence summary used as subtitle and email preview text   (optional)
//
//   Opening paragraph.
//
//   ## The Biggest Developments           (major section)
//   ### Story headline                    (story subheading)
//   Body paragraph with **bold**, *italic* and [a link](https://example.com).
//
//   That’s the week. See you next Monday.
//   — Prompted
//
// Blocks are separated by blank lines. A backslash escapes * [ ] and \.
import { parseWeekLabel, slugForWeek } from './weeks.mjs';
import { validateIssue, blocksText, CLOSING_LINE, SIGNOFF_LINE } from './issue-model.mjs';

export function parseInline(src) {
  const runs = [];
  const push = (text, marks) => {
    if (!text) return;
    const run = { text, ...marks }, prev = runs.at(-1);
    if (prev && prev.bold === run.bold && prev.italic === run.italic && prev.href === run.href) prev.text += text; else runs.push(run);
  };
  const walk = (s, marks) => {
    let buf = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\\' && '*[]\\'.includes(s[i + 1] || '')) { buf += s[++i]; continue; }
      if (c === '*') {
        const double = s[i + 1] === '*', tok = double ? '**' : '*';
        const end = s.indexOf(tok, i + tok.length);
        // Only treat as emphasis when it closes and wraps non-space text; otherwise it is a literal asterisk.
        if (end > i + tok.length && !/^\s|\s$/.test(s.slice(i + tok.length, end))) {
          push(buf, marks); buf = '';
          walk(s.slice(i + tok.length, end), { ...marks, [double ? 'bold' : 'italic']: true });
          i = end + tok.length - 1; continue;
        }
      }
      if (c === '[') {
        const m = /^\[((?:\\.|[^\]\\])+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*|mailto:[^\s)]+)\)/.exec(s.slice(i));
        if (m) { push(buf, marks); buf = ''; walk(m[1], { ...marks, href: m[2] }); i += m[0].length - 1; continue; }
      }
      buf += c;
    }
    push(buf, marks);
  };
  walk(src, {});
  return runs;
}

export function importIssueText(text, { number } = {}) {
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const first = lines.findIndex((l) => l.trim());
  const head = /^#\s+(?:Prompted\s+[—-]\s+)?Week of\s+(.+)$/.exec((lines[first] || '').trim());
  if (!head) throw new Error('The first line must be "# Week of <dates>", for example "# Week of November 8–15, 2026".');
  const week = parseWeekLabel(head[1]);
  let subtitle = '';
  const blocks = [];
  let para = [];
  const flush = () => {
    if (!para.length) return;
    // Lines inside one block are joined with a space: a paragraph is one paragraph.
    blocks.push({ type: 'paragraph', children: parseInline(para.join(' ')) });
    para = [];
  };
  for (const raw of lines.slice(first + 1)) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    let m;
    if ((m = /^>\s*(.+)$/.exec(line)) && !blocks.length && !para.length && !subtitle) { subtitle = m[1]; continue; }
    if ((m = /^(#{2,3})\s+(.+)$/.exec(line))) { flush(); blocks.push({ type: 'heading', level: m[1].length, children: parseInline(m[2]).map(({ bold, ...r }) => r) }); continue; }
    if (/^#\s/.test(line)) throw new Error(`Unexpected second title line: "${line}"`);
    if (line === SIGNOFF_LINE || line === CLOSING_LINE) { flush(); para.push(line); flush(); continue; }
    para.push(line);
  }
  flush();
  const paragraphs = blocks.filter((b) => b.type === 'paragraph');
  if (paragraphs.length) paragraphs[0].role = 'opening';
  for (const b of paragraphs) {
    const t = b.children.map((r) => r.text).join('').trim();
    if (t === CLOSING_LINE) b.role = 'closing';
    if (t === SIGNOFF_LINE) { b.role = 'signoff'; b.children = [{ text: SIGNOFF_LINE, italic: true }]; }
  }
  const issue = {
    number, schema: 'prompted-issue-1', slug: slugForWeek(week), title: `Prompted — Week of ${week.label}`, week, subtitle,
    publication: { date: week.nominal_send_date, basis: 'platform_scheduled_send' },
    source: { system: 'platform', post_id: null, slug: null, imported_from: 'approved text' },
    legacy: null, blocks,
  };
  validateIssue(issue);
  return issue;
}

export const issueTextDigest = (issue) => blocksText(issue.blocks);
